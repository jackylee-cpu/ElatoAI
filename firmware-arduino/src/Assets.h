#ifndef ASSETS_H
#define ASSETS_H

#include <stdint.h>

// Brand sounds kept in the "assets" data partition (P2-12, partition_16m.csv)
// instead of in the app, so one shared firmware can speak in each brand's
// voice and an OTA does not carry them. tools/build_assets.py writes the
// partition; the layout is described there.
//
// The partition is mapped into the address space once and read in place, the
// same way the PCM tables in SoundData.h are. A board without the partition,
// or with one that fails its checksum, simply has no assets: every lookup
// returns false and callers fall back to the built-in sound or to silence.

struct AssetSound {
    const char *name;
    const int16_t *pcm;  // 16-bit mono
    unsigned frames;
    int rate;
};

// Maps and checks the partition and logs what it holds. Safe to call more than
// once; only the first call does any work.
void assetsBegin();

bool assetsFind(const char *name, AssetSound *out);
int assetsCount();
bool assetsAt(int index, AssetSound *out);

#endif
