"use client";

import React, { useState } from "react";
import {
    Sheet,
    SheetContent,
    SheetDescription,
    SheetHeader,
    SheetTitle,
} from "@/components/ui/sheet";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Switch } from "@/components/ui/switch";
import { ScrollArea } from "@/components/ui/scroll-area";
import {
    Select,
    SelectContent,
    SelectItem,
    SelectTrigger,
    SelectValue,
} from "@/components/ui/select";
import { toast } from "@/components/ui/use-toast";
import { ImagePlus, Loader2, X } from "lucide-react";
import Image from "next/image";
import { createClient } from "@/utils/supabase/client";
import { getPersonalityImageSrc } from "@/lib/utils";
import {
    uploadCharacterImage,
    MAX_CHARACTER_IMAGE_BYTES,
} from "@/db/personalities";
import {
    createPersonalityAction,
    updatePersonalityAction,
} from "@/app/home/admin/actions";
import { modesAllowedBy, stylesAllowedBy } from "@/db/sessionOptions";

// Radix Select cannot hold an empty value, so "none" stands for null.
const NONE = "none";

const EMPTY: Partial<IPersonality> = {
    key: "",
    title: "",
    subtitle: "",
    short_description: "",
    character_prompt: "",
    first_message_prompt: "",
    voice_prompt: "",
    oai_voice: "Friendly_Person",
    voices: {},
    provider: "openrouter",
    image_url: null,
    is_child_voice: false,
    is_story: false,
    is_hidden: false,
    ip_key: "house",
    mode_key: null,
    style_key: null,
};

interface CharacterEditSheetProps {
    /** The character being edited, or null to create a new built-in one. */
    personality: IAdminPersonality | null;
    open: boolean;
    onOpenChange: (open: boolean) => void;
    ips: IIp[];
    modes: IMode[];
    styles: IStyle[];
}

const CharacterEditSheet: React.FC<CharacterEditSheetProps> = ({
    personality,
    open,
    onOpenChange,
    ips,
    modes,
    styles,
}) => {
    const creating = personality === null;
    const [draft, setDraft] = useState<Partial<IPersonality>>(
        personality ?? EMPTY,
    );
    const [saving, setSaving] = useState(false);
    const [uploading, setUploading] = useState(false);

    // Remount on a different character rather than syncing in an effect: the
    // sheet holds a whole form of local edits and there is no sensible merge
    // between those and a new row.
    const set = <K extends keyof IPersonality>(field: K, value: IPersonality[K]) =>
        setDraft((current) => ({ ...current, [field]: value }));

    // Uploaded straight from the browser rather than through a server action:
    // the storage policies already allow an authenticated user to write to
    // their own folder, and a server action would have to carry the whole file
    // through the 1MB action body limit to gain nothing.
    const onPickImage = async (file: File | null) => {
        if (!file) {
            return;
        }
        if (!file.type.startsWith("image/")) {
            toast({
                title: "Not an image",
                description: "Pick a PNG, JPEG or WebP file.",
            });
            return;
        }
        if (file.size > MAX_CHARACTER_IMAGE_BYTES) {
            toast({
                title: "Image too large",
                description: "Please pick an image under 5MB.",
            });
            return;
        }

        setUploading(true);
        try {
            const supabase = createClient();
            const {
                data: { user },
            } = await supabase.auth.getUser();
            if (!user) {
                throw new Error("No signed-in user");
            }
            const url = await uploadCharacterImage(supabase, user.id, file);
            set("image_url", url);
        } catch (error) {
            console.error("Could not upload the character image", error);
            toast({
                title: "Upload failed",
                description: "The image could not be uploaded.",
            });
        } finally {
            setUploading(false);
        }
    };

    // An uploaded picture wins; a built-in with none still has the artwork
    // bundled with the frontend under /personality, which is worth showing so
    // an admin can see there is already an image before replacing it.
    const bundledImage =
        !creating && personality.creator_id === null && draft.key
            ? getPersonalityImageSrc(draft.key)
            : null;
    const previewImage = draft.image_url ?? bundledImage;

    // Only what the character's IP allows is offered. Moving the character to
    // an IP that does not allow its current mode or style clears it, rather
    // than leaving a choice the voice server would silently drop.
    const ipOf = (ipKey: string | undefined) =>
        ips.find((ip) => ip.ip_key === (ipKey ?? "house"));
    const allowedModes = modesAllowedBy(ipOf(draft.ip_key), modes);
    const allowedStyles = stylesAllowedBy(ipOf(draft.ip_key), styles);
    const onIpChange = (ipKey: string) =>
        setDraft((current) => {
            const ip = ipOf(ipKey);
            const keepMode = modesAllowedBy(ip, modes).some(
                (m) => m.mode_key === current.mode_key,
            );
            const keepStyle = stylesAllowedBy(ip, styles).some(
                (s) => s.style_key === current.style_key,
            );
            return {
                ...current,
                ip_key: ipKey,
                mode_key: keepMode ? current.mode_key : null,
                style_key: keepStyle ? current.style_key : null,
            };
        });

    const setLangVoice = (code: string, value: string) =>
        setDraft((current) => ({
            ...current,
            voices: { ...(current.voices ?? {}), [code]: value },
        }));

    const onSave = async () => {
        setSaving(true);
        const result = creating
            ? await createPersonalityAction(draft)
            : await updatePersonalityAction(personality.personality_id, draft);
        setSaving(false);

        if (result.ok) {
            toast({
                title: creating ? "Character created" : "Character saved",
                description: creating
                    ? "It is now on the Playground for everyone."
                    : "Toys pick it up when they next reconnect.",
            });
            onOpenChange(false);
        } else {
            toast({ title: "Could not save", description: result.error });
        }
    };

    return (
        <Sheet open={open} onOpenChange={onOpenChange}>
            <SheetContent className="w-full sm:max-w-xl p-0 flex flex-col">
                <SheetHeader className="p-6 pb-2">
                    <SheetTitle>
                        {creating ? "New character" : draft.title || "Character"}
                    </SheetTitle>
                    <SheetDescription>
                        {creating
                            ? "Created as a built-in character, visible to every account."
                            : personality?.creator_email
                              ? `Made by ${personality.creator_email}`
                              : "Built-in character"}
                    </SheetDescription>
                </SheetHeader>

                <ScrollArea className="flex-1 px-6">
                    <div className="flex flex-col gap-4 pb-6">
                        {creating && (
                            <Field
                                label="Key"
                                hint="Lowercase, numbers and underscores. Permanent — conversations and memories are filed under it."
                            >
                                <Input
                                    value={draft.key ?? ""}
                                    onChange={(event) => set("key", event.target.value)}
                                    placeholder="space_explorer"
                                />
                            </Field>
                        )}

                        {ips.length > 0 && (
                            <Field
                                label="IP"
                                hint="Whose world this character is in. Memories are kept per IP, so moving a character to another IP starts its children's memory afresh there."
                            >
                                <Select
                                    value={draft.ip_key ?? "house"}
                                    onValueChange={onIpChange}
                                >
                                    <SelectTrigger>
                                        <SelectValue />
                                    </SelectTrigger>
                                    <SelectContent>
                                        {ips.map((ip) => (
                                            <SelectItem key={ip.ip_key} value={ip.ip_key}>
                                                {ip.name}
                                                {ip.is_hidden ? " (hidden)" : ""}
                                            </SelectItem>
                                        ))}
                                    </SelectContent>
                                </Select>
                            </Field>
                        )}

                        {modes.length > 0 && (
                            <Field
                                label="Activity"
                                hint="What the character does when a conversation starts. The child can still ask it to switch to another activity its IP allows. None = the character prompt alone."
                            >
                                <Select
                                    value={draft.mode_key ?? NONE}
                                    onValueChange={(value) =>
                                        set("mode_key", value === NONE ? null : value)
                                    }
                                >
                                    <SelectTrigger>
                                        <SelectValue />
                                    </SelectTrigger>
                                    <SelectContent>
                                        <SelectItem value={NONE}>None</SelectItem>
                                        {allowedModes.map((mode) => (
                                            <SelectItem key={mode.mode_key} value={mode.mode_key}>
                                                {mode.name}
                                            </SelectItem>
                                        ))}
                                    </SelectContent>
                                </Select>
                            </Field>
                        )}

                        {styles.length > 0 && (
                            <Field
                                label="Personality"
                                hint="The manner it speaks in, on top of the character prompt. It never overrides the IP's rules."
                            >
                                <Select
                                    value={draft.style_key ?? NONE}
                                    onValueChange={(value) =>
                                        set("style_key", value === NONE ? null : value)
                                    }
                                >
                                    <SelectTrigger>
                                        <SelectValue />
                                    </SelectTrigger>
                                    <SelectContent>
                                        <SelectItem value={NONE}>None</SelectItem>
                                        {allowedStyles.map((style) => (
                                            <SelectItem key={style.style_key} value={style.style_key}>
                                                {style.name}
                                            </SelectItem>
                                        ))}
                                    </SelectContent>
                                </Select>
                            </Field>
                        )}

                        <Field label="Title">
                            <Input
                                value={draft.title ?? ""}
                                onChange={(event) => set("title", event.target.value)}
                            />
                        </Field>

                        <Field
                            label="Image"
                            hint="Shown on the Playground tile. Without one a user-made character falls back to an emoji."
                        >
                            <div className="flex flex-row items-center gap-4">
                                <div className="relative h-20 w-20 shrink-0 overflow-hidden rounded-full border bg-muted">
                                    {previewImage ? (
                                        <Image
                                            src={previewImage}
                                            alt={draft.title || "Character"}
                                            fill
                                            unoptimized
                                            className="object-cover object-top"
                                        />
                                    ) : (
                                        <div className="flex h-full w-full items-center justify-center text-muted-foreground">
                                            <ImagePlus className="h-6 w-6" />
                                        </div>
                                    )}
                                </div>
                                <div className="flex flex-col gap-2">
                                    <label
                                        htmlFor="adminCharacterImage"
                                        className="inline-flex w-fit cursor-pointer items-center gap-2 rounded-md border bg-background px-3 py-2 text-sm font-medium shadow-sm hover:bg-accent"
                                    >
                                        {uploading ? (
                                            <Loader2 className="h-4 w-4 animate-spin" />
                                        ) : (
                                            <ImagePlus className="h-4 w-4" />
                                        )}
                                        {uploading
                                            ? "Uploading…"
                                            : previewImage
                                              ? "Replace image"
                                              : "Upload image"}
                                    </label>
                                    <input
                                        id="adminCharacterImage"
                                        type="file"
                                        accept="image/*"
                                        className="hidden"
                                        disabled={uploading}
                                        onChange={(event) => {
                                            void onPickImage(
                                                event.target.files?.[0] ?? null,
                                            );
                                            // Let the same file be picked again
                                            // after clearing it.
                                            event.target.value = "";
                                        }}
                                    />
                                    {draft.image_url && (
                                        <button
                                            type="button"
                                            onClick={() => set("image_url", null)}
                                            className="inline-flex w-fit items-center gap-1 text-xs text-muted-foreground hover:text-foreground"
                                        >
                                            <X className="h-3 w-3" /> Remove
                                        </button>
                                    )}
                                    <span className="text-xs text-muted-foreground">
                                        PNG, JPEG or WebP, up to 5MB
                                    </span>
                                </div>
                            </div>
                        </Field>

                        <Field label="Subtitle">
                            <Input
                                value={draft.subtitle ?? ""}
                                onChange={(event) => set("subtitle", event.target.value)}
                            />
                        </Field>

                        <Field label="Short description">
                            <Textarea
                                rows={2}
                                value={draft.short_description ?? ""}
                                onChange={(event) =>
                                    set("short_description", event.target.value)
                                }
                            />
                        </Field>

                        <Field
                            label="Character prompt"
                            hint="The system instruction. The server appends the child's profile, the memory brief and the spoken-output rules after it."
                        >
                            <Textarea
                                rows={14}
                                className="font-mono text-xs"
                                value={draft.character_prompt ?? ""}
                                onChange={(event) =>
                                    set("character_prompt", event.target.value)
                                }
                            />
                        </Field>

                        <Field
                            label="First message"
                            hint="How the toy opens a conversation. Left empty it just introduces itself."
                        >
                            <Textarea
                                rows={3}
                                value={draft.first_message_prompt ?? ""}
                                onChange={(event) =>
                                    set("first_message_prompt", event.target.value)
                                }
                            />
                        </Field>

                        <Field label="Voice prompt" hint="How the voice should sound.">
                            <Textarea
                                rows={2}
                                value={draft.voice_prompt ?? ""}
                                onChange={(event) => set("voice_prompt", event.target.value)}
                            />
                        </Field>

                        <Field
                            label="English voice id"
                            hint="MiniMax, e.g. Calm_Woman or Lively_Girl. Used on English sessions and as the fallback."
                        >
                            <Input
                                value={draft.oai_voice ?? ""}
                                onChange={(event) => set("oai_voice", event.target.value)}
                            />
                        </Field>

                        <Field
                            label="Cantonese voice id"
                            hint="e.g. Cantonese_CuteGirl or Cantonese_KindWoman. Empty uses the language default."
                        >
                            <Input
                                value={draft.voices?.["zh-HK"] ?? ""}
                                onChange={(event) =>
                                    setLangVoice("zh-HK", event.target.value)
                                }
                            />
                        </Field>

                        <Field
                            label="Mandarin voice id"
                            hint="e.g. Chinese (Mandarin)_Warm_Girl. Empty uses the language default."
                        >
                            <Input
                                value={draft.voices?.["zh-CN"] ?? ""}
                                onChange={(event) =>
                                    setLangVoice("zh-CN", event.target.value)
                                }
                            />
                        </Field>

                        <Toggle
                            label="Child voice"
                            checked={Boolean(draft.is_child_voice)}
                            onChange={(value) => set("is_child_voice", value)}
                        />
                        <Toggle
                            label="Story character"
                            checked={Boolean(draft.is_story)}
                            onChange={(value) => set("is_story", value)}
                        />
                        <Toggle
                            label="Hidden"
                            hint="Retires it from the picker. Children already using it keep it — the row is never deleted."
                            checked={Boolean(draft.is_hidden)}
                            onChange={(value) => set("is_hidden", value)}
                        />
                    </div>
                </ScrollArea>

                <div className="border-t p-4 flex flex-row gap-2 justify-end">
                    <Button variant="outline" onClick={() => onOpenChange(false)}>
                        Cancel
                    </Button>
                    <Button onClick={onSave} disabled={saving}>
                        {saving && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
                        {creating ? "Create" : "Save"}
                    </Button>
                </div>
            </SheetContent>
        </Sheet>
    );
};

export const Field: React.FC<{
    label: string;
    hint?: string;
    children: React.ReactNode;
}> = ({ label, hint, children }) => (
    <div className="flex flex-col gap-1.5">
        <Label>{label}</Label>
        {children}
        {hint && <p className="text-xs text-muted-foreground">{hint}</p>}
    </div>
);

export const Toggle: React.FC<{
    label: string;
    hint?: string;
    checked: boolean;
    onChange: (value: boolean) => void;
}> = ({ label, hint, checked, onChange }) => (
    <div className="flex flex-row items-center justify-between gap-4">
        <div className="flex flex-col gap-0.5">
            <Label>{label}</Label>
            {hint && <p className="text-xs text-muted-foreground">{hint}</p>}
        </div>
        <Switch checked={checked} onCheckedChange={onChange} />
    </div>
);

export default CharacterEditSheet;
