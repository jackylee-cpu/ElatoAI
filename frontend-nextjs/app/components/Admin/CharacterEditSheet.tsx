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
import { toast } from "@/components/ui/use-toast";
import { Loader2 } from "lucide-react";
import {
    createPersonalityAction,
    updatePersonalityAction,
} from "@/app/home/admin/actions";

const EMPTY: Partial<IPersonality> = {
    key: "",
    title: "",
    subtitle: "",
    short_description: "",
    character_prompt: "",
    first_message_prompt: "",
    voice_prompt: "",
    oai_voice: "Friendly_Person",
    provider: "openrouter",
    is_child_voice: false,
    is_story: false,
    is_hidden: false,
};

interface CharacterEditSheetProps {
    /** The character being edited, or null to create a new built-in one. */
    personality: IAdminPersonality | null;
    open: boolean;
    onOpenChange: (open: boolean) => void;
}

const CharacterEditSheet: React.FC<CharacterEditSheetProps> = ({
    personality,
    open,
    onOpenChange,
}) => {
    const creating = personality === null;
    const [draft, setDraft] = useState<Partial<IPersonality>>(
        personality ?? EMPTY,
    );
    const [saving, setSaving] = useState(false);

    // Remount on a different character rather than syncing in an effect: the
    // sheet holds a whole form of local edits and there is no sensible merge
    // between those and a new row.
    const set = <K extends keyof IPersonality>(field: K, value: IPersonality[K]) =>
        setDraft((current) => ({ ...current, [field]: value }));

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

                        <Field label="Title">
                            <Input
                                value={draft.title ?? ""}
                                onChange={(event) => set("title", event.target.value)}
                            />
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
                            label="Voice id"
                            hint="For the OpenRouter route this is a MiniMax voice, e.g. Calm_Woman or Lively_Girl."
                        >
                            <Input
                                value={draft.oai_voice ?? ""}
                                onChange={(event) => set("oai_voice", event.target.value)}
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

const Field: React.FC<{
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

const Toggle: React.FC<{
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
