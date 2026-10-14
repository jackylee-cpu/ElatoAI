#include "Assets.h"

#include <Arduino.h>
#include <esp_partition.h>
#include <esp_rom_crc.h>
#include <string.h>

namespace {

// Must match tools/build_assets.py.
constexpr char kMagic[4] = {'A', 'B', 'A', 'S'};
constexpr uint16_t kVersion = 1;
constexpr esp_partition_subtype_t kSubtype = (esp_partition_subtype_t)0x40;
constexpr int kMaxEntries = 64;

struct __attribute__((packed)) Header {
    char magic[4];
    uint16_t version;
    uint16_t count;
    uint32_t payloadBytes;  // everything after this header
    uint32_t crc32;         // esp_rom_crc32_le(0, payload)
    char brand[16];
};

struct __attribute__((packed)) Entry {
    char name[20];
    uint32_t offset;  // from the start of the partition
    uint32_t frames;
    uint32_t rate;
};

static_assert(sizeof(Header) == 32, "header layout");
static_assert(sizeof(Entry) == 32, "entry layout");

bool started = false;
const uint8_t *base = nullptr;
const Entry *entries = nullptr;
int entryCount = 0;

bool fail(const char *why) {
    Serial.printf("Assets: none (%s)\n", why);
    return false;
}

bool load() {
    const esp_partition_t *part =
        esp_partition_find_first(ESP_PARTITION_TYPE_DATA, kSubtype, "assets");
    if (!part) return fail("no assets partition");

    const void *mapped = nullptr;
    spi_flash_mmap_handle_t handle;
    if (esp_partition_mmap(part, 0, part->size, SPI_FLASH_MMAP_DATA, &mapped, &handle) != ESP_OK) {
        return fail("mmap failed");
    }
    const uint8_t *p = (const uint8_t *)mapped;
    const Header *h = (const Header *)p;

    // Everything below is checked before anything is trusted: the partition is
    // written at the factory, but it is still just bytes on a chip.
    if (memcmp(h->magic, kMagic, 4) != 0) {
        spi_flash_munmap(handle);
        return fail("partition empty or not an asset pack");
    }
    if (h->version != kVersion || h->count == 0 || h->count > kMaxEntries ||
        h->payloadBytes > part->size - sizeof(Header) ||
        (uint32_t)h->count * sizeof(Entry) > h->payloadBytes) {
        spi_flash_munmap(handle);
        return fail("bad header");
    }
    uint32_t t0 = micros();
    uint32_t crc = esp_rom_crc32_le(0, p + sizeof(Header), h->payloadBytes);
    uint32_t crcUs = micros() - t0;
    if (crc != h->crc32) {
        spi_flash_munmap(handle);
        return fail("checksum mismatch");
    }
    const Entry *e = (const Entry *)(p + sizeof(Header));
    const uint32_t end = sizeof(Header) + h->payloadBytes;
    for (int i = 0; i < h->count; i++) {
        uint64_t last = (uint64_t)e[i].offset + (uint64_t)e[i].frames * 2;
        if (e[i].offset % 2 || e[i].offset < sizeof(Header) || last > end ||
            e[i].rate < 8000 || e[i].rate > 48000 || e[i].name[sizeof(e[i].name) - 1] != '\0') {
            spi_flash_munmap(handle);
            return fail("bad entry");
        }
    }

    // Mapped for good: the sounds are played straight out of it.
    base = p;
    entries = e;
    entryCount = h->count;
    char brand[sizeof(h->brand) + 1] = {0};
    memcpy(brand, h->brand, sizeof(h->brand));
    Serial.printf("Assets: brand '%s', %d sounds, %u bytes, crc ok in %u us\n", brand, entryCount,
                  (unsigned)h->payloadBytes, (unsigned)crcUs);
    return true;
}

void fill(int i, AssetSound *out) {
    out->name = entries[i].name;
    out->pcm = (const int16_t *)(base + entries[i].offset);
    out->frames = entries[i].frames;
    out->rate = (int)entries[i].rate;
}

}  // namespace

void assetsBegin() {
    if (started) return;
    started = true;
    load();
}

int assetsCount() {
    assetsBegin();
    return entryCount;
}

bool assetsAt(int index, AssetSound *out) {
    assetsBegin();
    if (index < 0 || index >= entryCount) return false;
    fill(index, out);
    return true;
}

bool assetsFind(const char *name, AssetSound *out) {
    assetsBegin();
    for (int i = 0; i < entryCount; i++) {
        if (strncmp(entries[i].name, name, sizeof(entries[i].name)) == 0) {
            fill(i, out);
            return true;
        }
    }
    return false;
}
