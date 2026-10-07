"use client";

import React, { useMemo, useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import {
    Select,
    SelectContent,
    SelectItem,
    SelectTrigger,
    SelectValue,
} from "@/components/ui/select";
import {
    Table,
    TableBody,
    TableCell,
    TableHead,
    TableHeader,
    TableRow,
} from "@/components/ui/table";
import { toast } from "@/components/ui/use-toast";
import { Eye, EyeOff, Pencil, Plus } from "lucide-react";
import Image from "next/image";
import { getPersonalityAvatarSrc } from "@/lib/utils";
import CharacterEditSheet from "./CharacterEditSheet";
import { setPersonalityHiddenAction } from "@/app/home/admin/actions";

type Scope = "all" | "builtin" | "user" | "hidden";

interface CharactersTabProps {
    personalities: IAdminPersonality[];
    ips: IIp[];
}

const CharactersTab: React.FC<CharactersTabProps> = ({ personalities, ips }) => {
    const ipName = (ipKey: string | undefined) =>
        ips.find((ip) => ip.ip_key === (ipKey ?? "house"))?.name ?? ipKey ?? "house";
    const [search, setSearch] = useState("");
    const [scope, setScope] = useState<Scope>("all");
    const [editing, setEditing] = useState<IAdminPersonality | null>(null);
    const [creating, setCreating] = useState(false);
    const [busyId, setBusyId] = useState<string | null>(null);

    const filtered = useMemo(() => {
        const needle = search.trim().toLowerCase();
        return personalities.filter((entry) => {
            if (scope === "builtin" && entry.creator_id !== null) return false;
            if (scope === "user" && entry.creator_id === null) return false;
            if (scope === "hidden" && !entry.is_hidden) return false;
            if (!needle) return true;
            return [entry.title, entry.key, entry.creator_email, entry.character_prompt]
                .filter(Boolean)
                .some((field) => field!.toLowerCase().includes(needle));
        });
    }, [personalities, search, scope]);

    const onToggleHidden = async (entry: IAdminPersonality) => {
        setBusyId(entry.personality_id);
        const result = await setPersonalityHiddenAction(
            entry.personality_id,
            !entry.is_hidden,
        );
        setBusyId(null);
        if (!result.ok) {
            toast({ title: "Could not change it", description: result.error });
        }
    };

    return (
        <div className="flex flex-col gap-4">
            <div className="flex flex-row flex-wrap gap-2 items-center">
                <Input
                    placeholder="Search title, key, owner or prompt…"
                    value={search}
                    onChange={(event) => setSearch(event.target.value)}
                    className="max-w-sm"
                />
                <Select value={scope} onValueChange={(value) => setScope(value as Scope)}>
                    <SelectTrigger className="w-[180px]">
                        <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                        <SelectItem value="all">All characters</SelectItem>
                        <SelectItem value="builtin">Built-in</SelectItem>
                        <SelectItem value="user">Made by users</SelectItem>
                        <SelectItem value="hidden">Hidden</SelectItem>
                    </SelectContent>
                </Select>
                <Badge variant="outline">{filtered.length}</Badge>
                <Button className="ml-auto" onClick={() => setCreating(true)}>
                    <Plus className="mr-2 h-4 w-4" />
                    New character
                </Button>
            </div>

            <Card className="rounded-2xl border-0 bg-white/80 shadow-sm">
                <CardHeader className="pb-2">
                    <CardTitle className="text-base">Characters</CardTitle>
                    <CardDescription>
                        Editing a prompt takes effect the next time a session
                        starts. Hiding retires a character without deleting it.
                    </CardDescription>
                </CardHeader>
                <CardContent>
                    <Table>
                        <TableHeader>
                            <TableRow>
                                <TableHead>Title</TableHead>
                                <TableHead>Key</TableHead>
                                <TableHead>IP</TableHead>
                                <TableHead>Owner</TableHead>
                                <TableHead>Voice</TableHead>
                                <TableHead className="text-right">Prompt</TableHead>
                                <TableHead className="w-[100px]" />
                            </TableRow>
                        </TableHeader>
                        <TableBody>
                            {filtered.map((entry) => (
                                <TableRow
                                    key={entry.personality_id}
                                    className={entry.is_hidden ? "opacity-50" : undefined}
                                >
                                    <TableCell className="font-medium">
                                        <div className="flex flex-row items-center gap-2">
                                            <div className="relative h-7 w-7 shrink-0 overflow-hidden rounded-full border bg-muted">
                                                {getPersonalityAvatarSrc(entry) && (
                                                    <Image
                                                        src={getPersonalityAvatarSrc(entry)!}
                                                        alt=""
                                                        fill
                                                        unoptimized
                                                        className="object-cover object-top"
                                                    />
                                                )}
                                            </div>
                                            {entry.title || "—"}
                                            {entry.is_hidden && (
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
                                        {entry.key}
                                    </TableCell>
                                    <TableCell className="text-xs whitespace-nowrap">
                                        {ipName(entry.ip_key)}
                                    </TableCell>
                                    <TableCell className="text-xs">
                                        {entry.creator_id === null ? (
                                            <span className="text-muted-foreground">
                                                built-in
                                            </span>
                                        ) : (
                                            (entry.creator_email ?? "unknown")
                                        )}
                                    </TableCell>
                                    <TableCell className="text-xs whitespace-nowrap">
                                        <div>{entry.oai_voice}</div>
                                        {entry.voices?.["zh-HK"] && (
                                            <div className="text-muted-foreground">
                                                yue {entry.voices["zh-HK"]}
                                            </div>
                                        )}
                                        {entry.voices?.["zh-CN"] && (
                                            <div className="text-muted-foreground">
                                                zh {entry.voices["zh-CN"]}
                                            </div>
                                        )}
                                    </TableCell>
                                    <TableCell className="text-right text-xs text-muted-foreground tabular-nums">
                                        {entry.character_prompt?.length ?? 0} chars
                                    </TableCell>
                                    <TableCell>
                                        <div className="flex flex-row gap-1 justify-end">
                                            <Button
                                                variant="ghost"
                                                size="icon"
                                                title="Edit"
                                                onClick={() => setEditing(entry)}
                                            >
                                                <Pencil className="h-4 w-4" />
                                            </Button>
                                            <Button
                                                variant="ghost"
                                                size="icon"
                                                title={entry.is_hidden ? "Show" : "Hide"}
                                                disabled={busyId === entry.personality_id}
                                                onClick={() => onToggleHidden(entry)}
                                            >
                                                {entry.is_hidden ? (
                                                    <EyeOff className="h-4 w-4" />
                                                ) : (
                                                    <Eye className="h-4 w-4" />
                                                )}
                                            </Button>
                                        </div>
                                    </TableCell>
                                </TableRow>
                            ))}
                        </TableBody>
                    </Table>
                </CardContent>
            </Card>

            {/* Keyed so switching rows remounts the form rather than merging
                someone else's prompt into a half-finished edit. */}
            {editing && (
                <CharacterEditSheet
                    key={editing.personality_id}
                    personality={editing}
                    open
                    onOpenChange={(open) => !open && setEditing(null)}
                    ips={ips}
                />
            )}
            {creating && (
                <CharacterEditSheet
                    key="new"
                    personality={null}
                    open
                    onOpenChange={(open) => !open && setCreating(false)}
                    ips={ips}
                />
            )}
        </div>
    );
};

export default CharactersTab;
