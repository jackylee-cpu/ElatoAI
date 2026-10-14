"use client";

import React, { useState } from "react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import {
    Table,
    TableBody,
    TableCell,
    TableHead,
    TableHeader,
    TableRow,
} from "@/components/ui/table";
import {
    Sheet,
    SheetContent,
    SheetDescription,
    SheetHeader,
    SheetTitle,
} from "@/components/ui/sheet";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Checkbox } from "@/components/ui/checkbox";
import { ScrollArea } from "@/components/ui/scroll-area";
import { toast } from "@/components/ui/use-toast";
import {
    Dialog,
    DialogContent,
    DialogDescription,
    DialogFooter,
    DialogHeader,
    DialogTitle,
} from "@/components/ui/dialog";
import {
    Select,
    SelectContent,
    SelectItem,
    SelectTrigger,
    SelectValue,
} from "@/components/ui/select";
import {
    DropdownMenu,
    DropdownMenuContent,
    DropdownMenuItem,
    DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { ImagePlus, Loader2, MoreHorizontal, Plus, X } from "lucide-react";
import Image from "next/image";
import { createClient } from "@/utils/supabase/client";
import { uploadCharacterImage, MAX_CHARACTER_IMAGE_BYTES } from "@/db/personalities";
import { Field, Toggle } from "./CharacterEditSheet";
import { saveIpAction, setIpHiddenAction, type IpDraft } from "@/app/admin/actions";

interface IpsTabProps {
    ips: IIp[];
    modes: IMode[];
    styles: IStyle[];
    personalities: IAdminPersonality[];
}

const IpsTab: React.FC<IpsTabProps> = ({ ips, modes, styles, personalities }) => {
    const [editing, setEditing] = useState<IIp | null>(null);
    const [creating, setCreating] = useState(false);
    const [busyKey, setBusyKey] = useState<string | null>(null);
    const [removing, setRemoving] = useState<IIp | null>(null);

    const characterCount = (ipKey: string) =>
        personalities.filter((p) => (p.ip_key ?? "house") === ipKey).length;

    const summary = (allowedCount: number, restricted: boolean, total: number) =>
        restricted ? `${allowedCount} of ${total}` : "all";

    const onToggleHidden = async (ip: IIp) => {
        setBusyKey(ip.ip_key);
        const result = await setIpHiddenAction(ip.ip_key, !ip.is_hidden);
        setBusyKey(null);
        if (!result.ok) {
            toast({ title: "Could not change it", description: result.error });
        }
    };

    return (
        <div className="flex flex-col gap-4">
            <div className="flex flex-row items-center">
                <Badge variant="outline">{ips.length}</Badge>
                <Button className="ml-auto" onClick={() => setCreating(true)}>
                    <Plus className="mr-2 h-4 w-4" />
                    New IP
                </Button>
            </div>

            <Card className="rounded-2xl border-0 bg-white/80 shadow-sm">
                <CardHeader className="pb-2">
                    <CardTitle className="text-base">IPs</CardTitle>
                    <CardDescription>
                        Each character belongs to one IP, and a child&apos;s
                        memories are kept per IP. An IP can add rules for all
                        its characters and limit which activities and
                        personalities they use. Activities and personalities
                        themselves are defined in the voice server&apos;s
                        content/*.yaml.
                    </CardDescription>
                </CardHeader>
                <CardContent>
                    <Table>
                        <TableHeader>
                            <TableRow>
                                <TableHead>Name</TableHead>
                                <TableHead>Key</TableHead>
                                <TableHead>Characters</TableHead>
                                <TableHead>Activities</TableHead>
                                <TableHead>Personalities</TableHead>
                                <TableHead>Rules</TableHead>
                                <TableHead className="w-[60px]" />
                            </TableRow>
                        </TableHeader>
                        <TableBody>
                            {ips.map((ip) => (
                                <TableRow
                                    key={ip.ip_key}
                                    className={ip.is_hidden ? "opacity-50" : undefined}
                                >
                                    <TableCell className="font-medium">
                                        <div className="flex flex-row items-center gap-2">
                                            <div className="relative h-8 w-8 shrink-0 overflow-hidden rounded-md border bg-muted">
                                                {ip.image_url && (
                                                    <Image
                                                        src={ip.image_url}
                                                        alt=""
                                                        fill
                                                        unoptimized
                                                        className="object-cover"
                                                    />
                                                )}
                                            </div>
                                            {ip.name}
                                            {ip.is_hidden && (
                                                <Badge
                                                    variant="outline"
                                                    className="text-[10px] px-1 py-0"
                                                >
                                                    hidden
                                                </Badge>
                                            )}
                                        </div>
                                    </TableCell>
                                    <TableCell className="text-xs font-mono">
                                        {ip.ip_key}
                                    </TableCell>
                                    <TableCell className="text-xs tabular-nums">
                                        {characterCount(ip.ip_key)}
                                    </TableCell>
                                    <TableCell className="text-xs">
                                        {summary(
                                            ip.ip_modes?.length ?? 0,
                                            ip.restrict_modes,
                                            modes.length,
                                        )}
                                    </TableCell>
                                    <TableCell className="text-xs">
                                        {summary(
                                            ip.ip_styles?.length ?? 0,
                                            ip.restrict_styles,
                                            styles.length,
                                        )}
                                    </TableCell>
                                    <TableCell className="text-xs text-muted-foreground tabular-nums">
                                        {ip.guardrails ? `${ip.guardrails.length} chars` : "none"}
                                    </TableCell>
                                    <TableCell className="w-12 text-right">
                                        <DropdownMenu>
                                            <DropdownMenuTrigger asChild>
                                                <Button
                                                    type="button"
                                                    variant="ghost"
                                                    size="icon"
                                                    className="h-8 w-8"
                                                    aria-label={`Actions for ${ip.name}`}
                                                    disabled={busyKey === ip.ip_key}
                                                >
                                                    <MoreHorizontal className="h-4 w-4" />
                                                </Button>
                                            </DropdownMenuTrigger>
                                            <DropdownMenuContent align="end">
                                                <DropdownMenuItem onSelect={() => setEditing(ip)}>
                                                    Edit
                                                </DropdownMenuItem>
                                                {ip.is_hidden ? (
                                                    <DropdownMenuItem onSelect={() => onToggleHidden(ip)}>
                                                        Show
                                                    </DropdownMenuItem>
                                                ) : (
                                                    <DropdownMenuItem
                                                        className="text-rose-700 focus:bg-rose-50 focus:text-rose-800"
                                                        onSelect={() => setRemoving(ip)}
                                                    >
                                                        Delete
                                                    </DropdownMenuItem>
                                                )}
                                            </DropdownMenuContent>
                                        </DropdownMenu>
                                    </TableCell>
                                </TableRow>
                            ))}
                        </TableBody>
                    </Table>
                </CardContent>
            </Card>

            {editing && (
                <IpEditSheet
                    key={editing.ip_key}
                    ip={editing}
                    modes={modes}
                    styles={styles}
                    characters={personalities.filter(
                        (p) => (p.ip_key ?? "house") === editing.ip_key,
                    )}
                    onClose={() => setEditing(null)}
                />
            )}
            {creating && (
                <IpEditSheet
                    key="new"
                    ip={null}
                    modes={modes}
                    styles={styles}
                    characters={[]}
                    onClose={() => setCreating(false)}
                />
            )}
            <Dialog open={removing !== null} onOpenChange={(open) => !open && !busyKey && setRemoving(null)}>
                <DialogContent className="max-w-md">
                    <DialogHeader>
                        <DialogTitle>Delete {removing?.name ?? "this IP"}</DialogTitle>
                        <DialogDescription>
                            Takes it off the playground. The row stays, and children already
                            on one of its characters keep it. You can show it again from this menu.
                        </DialogDescription>
                    </DialogHeader>
                    <DialogFooter className="gap-2">
                        <Button
                            type="button"
                            variant="outline"
                            className="rounded-full"
                            onClick={() => setRemoving(null)}
                            disabled={busyKey !== null}
                        >
                            Cancel
                        </Button>
                        <Button
                            type="button"
                            variant="destructive"
                            className="rounded-full"
                            disabled={busyKey !== null}
                            onClick={() => {
                                if (!removing) return;
                                const ip = removing;
                                setRemoving(null);
                                onToggleHidden(ip);
                            }}
                        >
                            Delete
                        </Button>
                    </DialogFooter>
                </DialogContent>
            </Dialog>
        </div>
    );
};

const NO_DEFAULT = "__none__";

const toDraft = (ip: IIp | null, modes: IMode[]): IpDraft => {
    const rows = new Map((ip?.ip_modes ?? []).map((row) => [row.mode_key, row.prompt]));
    return {
        ip_key: ip?.ip_key ?? "",
        name: ip?.name ?? "",
        description: ip?.description ?? "",
        guardrails: ip?.guardrails ?? "",
        restrict_modes: ip?.restrict_modes ?? false,
        restrict_styles: ip?.restrict_styles ?? false,
        is_hidden: ip?.is_hidden ?? false,
        sort_order: ip?.sort_order ?? 0,
        default_personality_id: ip?.default_personality_id ?? null,
        image_url: ip?.image_url ?? null,
        modes: modes.map((mode) => ({
            mode_key: mode.mode_key,
            // Only a restricted IP's rows are an allow list.
            allowed: !ip?.restrict_modes || rows.has(mode.mode_key),
            prompt: rows.get(mode.mode_key) ?? "",
        })),
        style_keys: ip?.restrict_styles
            ? (ip.ip_styles ?? []).map((row) => row.style_key)
            : [],
    };
};

const IpEditSheet: React.FC<{
    ip: IIp | null;
    modes: IMode[];
    styles: IStyle[];
    // This IP's characters, for its default.
    characters: IAdminPersonality[];
    onClose: () => void;
}> = ({ ip, modes, styles, characters, onClose }) => {
    const creating = ip === null;
    const [draft, setDraft] = useState<IpDraft>(() => toDraft(ip, modes));
    const [saving, setSaving] = useState(false);
    const [uploading, setUploading] = useState(false);

    const set = <K extends keyof IpDraft>(field: K, value: IpDraft[K]) =>
        setDraft((current) => ({ ...current, [field]: value }));
    const setMode = (modeKey: string, change: Partial<IpDraft["modes"][number]>) =>
        setDraft((current) => ({
            ...current,
            modes: current.modes.map((mode) =>
                mode.mode_key === modeKey ? { ...mode, ...change } : mode,
            ),
        }));
    const toggleStyle = (styleKey: string, on: boolean) =>
        setDraft((current) => ({
            ...current,
            style_keys: on
                ? [...current.style_keys, styleKey]
                : current.style_keys.filter((key) => key !== styleKey),
        }));

    // Straight from the browser into the character image bucket, as on the
    // character sheet: the file would not fit through a server action's 1MB
    // body, and the bucket's policies already let a signed-in user write to
    // their own folder.
    const onPickImage = async (file: File | null) => {
        if (!file) {
            return;
        }
        if (!file.type.startsWith("image/")) {
            toast({ title: "Not an image", description: "Pick a PNG, JPEG or WebP file." });
            return;
        }
        if (file.size > MAX_CHARACTER_IMAGE_BYTES) {
            toast({ title: "Image too large", description: "Please pick an image under 5MB." });
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
            set("image_url", await uploadCharacterImage(supabase, user.id, file));
        } catch (error) {
            console.error("Could not upload the IP image", error);
            toast({ title: "Upload failed", description: "The image could not be uploaded." });
        } finally {
            setUploading(false);
        }
    };

    const onSave = async () => {
        setSaving(true);
        const result = await saveIpAction(draft, creating);
        setSaving(false);
        if (result.ok) {
            toast({
                title: creating ? "IP created" : "IP saved",
                description: "Sessions pick it up when they next start.",
            });
            onClose();
        } else {
            toast({ title: "Could not save", description: result.error });
        }
    };

    return (
        <Sheet open onOpenChange={(open) => !open && onClose()}>
            <SheetContent className="w-full sm:max-w-xl p-0 flex flex-col">
                <SheetHeader className="p-6 pb-2">
                    <SheetTitle>{creating ? "New IP" : draft.name || "IP"}</SheetTitle>
                    <SheetDescription>
                        Characters are moved into an IP from the Characters tab.
                    </SheetDescription>
                </SheetHeader>

                <ScrollArea className="flex-1 px-6">
                    <div className="flex flex-col gap-4 pb-6">
                        {creating && (
                            <Field
                                label="Key"
                                hint="Lowercase, numbers, - and _. Permanent — memories are filed under it."
                            >
                                <Input
                                    value={draft.ip_key}
                                    onChange={(event) => set("ip_key", event.target.value)}
                                    placeholder="space_friends"
                                />
                            </Field>
                        )}

                        <Field label="Name">
                            <Input
                                value={draft.name}
                                onChange={(event) => set("name", event.target.value)}
                            />
                        </Field>

                        <Field label="Description">
                            <Textarea
                                rows={2}
                                value={draft.description}
                                onChange={(event) => set("description", event.target.value)}
                            />
                        </Field>

                        <Field
                            label="Toy photo"
                            hint="Shown to the parent once a board set to this toy is bound, so they can tell which toy it is. Without one the app shows a generic bear."
                        >
                            <div className="flex flex-row items-center gap-4">
                                <div className="relative h-20 w-20 shrink-0 overflow-hidden rounded-2xl border bg-muted">
                                    {draft.image_url ? (
                                        <Image
                                            src={draft.image_url}
                                            alt={draft.name || "Toy"}
                                            fill
                                            unoptimized
                                            className="object-cover"
                                        />
                                    ) : (
                                        <div className="flex h-full w-full items-center justify-center text-muted-foreground">
                                            <ImagePlus className="h-6 w-6" />
                                        </div>
                                    )}
                                </div>
                                <div className="flex flex-col gap-2">
                                    <label
                                        htmlFor="adminIpImage"
                                        className="inline-flex w-fit cursor-pointer items-center gap-2 rounded-md border bg-background px-3 py-2 text-sm font-medium shadow-sm hover:bg-accent"
                                    >
                                        {uploading ? (
                                            <Loader2 className="h-4 w-4 animate-spin" />
                                        ) : (
                                            <ImagePlus className="h-4 w-4" />
                                        )}
                                        {uploading
                                            ? "Uploading…"
                                            : draft.image_url
                                              ? "Replace image"
                                              : "Upload image"}
                                    </label>
                                    <input
                                        id="adminIpImage"
                                        type="file"
                                        accept="image/*"
                                        className="hidden"
                                        disabled={uploading}
                                        onChange={(event) => {
                                            void onPickImage(event.target.files?.[0] ?? null);
                                            // Let the same file be picked again after removing it.
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

                        <Field
                            label="Default character"
                            hint="An IP is one toy. A board set to this toy (Devices tab) runs the account's character if it is one of these, otherwise this one. None: the first visible character."
                        >
                            {characters.length === 0 ? (
                                <p className="text-xs text-muted-foreground">
                                    No characters yet. Move one into this IP from the Characters tab.
                                </p>
                            ) : (
                                <Select
                                    value={draft.default_personality_id ?? NO_DEFAULT}
                                    onValueChange={(value) =>
                                        set("default_personality_id", value === NO_DEFAULT ? null : value)
                                    }
                                >
                                    <SelectTrigger>
                                        <SelectValue />
                                    </SelectTrigger>
                                    <SelectContent>
                                        <SelectItem value={NO_DEFAULT}>None</SelectItem>
                                        {characters.map((character) => (
                                            <SelectItem
                                                key={character.personality_id}
                                                value={character.personality_id}
                                            >
                                                {character.title}
                                                {character.is_hidden ? " (hidden)" : ""}
                                            </SelectItem>
                                        ))}
                                    </SelectContent>
                                </Select>
                            )}
                        </Field>

                        <Field
                            label="Rules for every character"
                            hint="Hard limits, e.g. what a licensor never allows. They come after the personality and the activity in the prompt, so neither can talk a character past them."
                        >
                            <Textarea
                                rows={5}
                                className="font-mono text-xs"
                                value={draft.guardrails}
                                onChange={(event) => set("guardrails", event.target.value)}
                            />
                        </Field>

                        <Toggle
                            label="Limit activities"
                            hint="Off: every activity, including ones added later. On: only those ticked."
                            checked={draft.restrict_modes}
                            onChange={(value) => set("restrict_modes", value)}
                        />
                        {modes.map((mode) => {
                            const row = draft.modes.find((m) => m.mode_key === mode.mode_key)!;
                            const enabled = !draft.restrict_modes || row.allowed;
                            return (
                                <div
                                    key={mode.mode_key}
                                    className="flex flex-col gap-1.5 rounded-lg border p-3"
                                >
                                    <label className="flex flex-row items-center gap-2 text-sm font-medium">
                                        {draft.restrict_modes && (
                                            <Checkbox
                                                checked={row.allowed}
                                                onCheckedChange={(value) =>
                                                    setMode(mode.mode_key, {
                                                        allowed: value === true,
                                                    })
                                                }
                                            />
                                        )}
                                        {mode.name}
                                    </label>
                                    {enabled && (
                                        <Textarea
                                            rows={2}
                                            className="text-xs"
                                            placeholder="How this IP's characters do it (optional)"
                                            value={row.prompt}
                                            onChange={(event) =>
                                                setMode(mode.mode_key, {
                                                    prompt: event.target.value,
                                                })
                                            }
                                        />
                                    )}
                                </div>
                            );
                        })}

                        <Toggle
                            label="Limit personalities"
                            hint="Off: every personality, including ones added later. On: only those ticked."
                            checked={draft.restrict_styles}
                            onChange={(value) => set("restrict_styles", value)}
                        />
                        {draft.restrict_styles &&
                            styles.map((style) => (
                                <label
                                    key={style.style_key}
                                    className="flex flex-row items-center gap-2 text-sm"
                                >
                                    <Checkbox
                                        checked={draft.style_keys.includes(style.style_key)}
                                        onCheckedChange={(value) =>
                                            toggleStyle(style.style_key, value === true)
                                        }
                                    />
                                    {style.name}
                                </label>
                            ))}

                        <Field label="Sort order">
                            <Input
                                type="number"
                                value={draft.sort_order}
                                onChange={(event) =>
                                    set("sort_order", Number(event.target.value))
                                }
                            />
                        </Field>

                        <Toggle
                            label="Hidden"
                            hint="Takes the IP off the playground. Children already on one of its characters keep it."
                            checked={draft.is_hidden}
                            onChange={(value) => set("is_hidden", value)}
                        />
                    </div>
                </ScrollArea>

                <div className="border-t p-4 flex flex-row gap-2 justify-end">
                    <Button variant="outline" onClick={onClose}>
                        Cancel
                    </Button>
                    <Button onClick={onSave} disabled={saving || uploading}>
                        {saving && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
                        {creating ? "Create" : "Save"}
                    </Button>
                </div>
            </SheetContent>
        </Sheet>
    );
};

export default IpsTab;
