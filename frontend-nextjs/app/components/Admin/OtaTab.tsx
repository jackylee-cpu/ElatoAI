"use client";

import React, { useMemo, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
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
    Table,
    TableBody,
    TableCell,
    TableHead,
    TableHeader,
    TableRow,
} from "@/components/ui/table";
import { toast } from "@/components/ui/use-toast";
import { ActionResult, changeFirmwareRolloutAction, FirmwareRolloutChange } from "@/app/admin/actions";
import { deviceName } from "@/lib/usageCost";
import { cn } from "@/lib/utils";

/**
 * Firmware releases and their staged rollout (P2-21). Super admins only: the
 * page does not render it for anyone else, and the tables' policies and
 * admin_change_firmware_rollout() refuse everyone else anyway.
 *
 * A release goes: uploaded as a draft -> made current at the whitelist stage ->
 * widened to 10%, 50%, 100%. A board is offered the current release when it is
 * on the whitelist or its MAC hashes into the stage's share (lib/otaRollout.ts);
 * the counts beside each stage are worked out with that same hash. More than 5%
 * of the offered boards rolling back pauses it on its own (P2-19).
 */

const STAGES = [0, 10, 50, 100] as const;
type Stage = (typeof STAGES)[number];
const STAGE_LABELS: Record<Stage, string> = { 0: "Whitelist", 10: "10%", 50: "50%", 100: "100%" };
const MAC = /^[0-9A-F]{2}(:[0-9A-F]{2}){5}$/;

type ReleaseState = "draft" | "rolling" | "paused" | "current" | "old";

const STATE_STYLES: Record<ReleaseState, string> = {
    draft: "bg-gray-100 text-gray-600 ring-gray-200",
    rolling: "bg-sky-50 text-[#2a78cf] ring-sky-200",
    paused: "bg-rose-50 text-rose-700 ring-rose-200",
    current: "bg-emerald-50 text-emerald-700 ring-emerald-200",
    old: "bg-gray-50 text-gray-500 ring-gray-200",
};

function stateOf(release: IAdminFirmwareRelease): ReleaseState {
    if (release.is_current) {
        if (release.paused_at) return "paused";
        return release.rollout_percent === 100 ? "current" : "rolling";
    }
    return release.stage_changed_at ? "old" : "draft";
}

function stateLabel(release: IAdminFirmwareRelease): string {
    switch (stateOf(release)) {
        case "draft": return "Draft";
        case "rolling": return `Rolling out · ${STAGE_LABELS[release.rollout_percent as Stage]}`;
        case "paused": return "Paused";
        case "current": return "Current";
        case "old": return "Old";
    }
}

function when(iso: string | null): string {
    if (!iso) return "—";
    return new Date(iso).toLocaleString("en-GB", {
        timeZone: "Asia/Hong_Kong",
        day: "numeric",
        month: "short",
        hour: "2-digit",
        minute: "2-digit",
    });
}

const mb = (bytes: number) => `${(bytes / 1024 / 1024).toFixed(2)} MB`;
const rolledBack = (release: IAdminFirmwareRelease) => release.rollout.filter((row) => row.failed_at);

interface OtaTabProps {
    releases: IAdminFirmwareRelease[];
    devices: IAdminDevice[];
    onOpenDevice: (mac: string) => void;
}

const OtaTab: React.FC<OtaTabProps> = ({ releases, devices, onOpenDevice }) => {
    const boards = useMemo(
        () => Array.from(new Map(releases.map((release) => [release.board, release.board_label]))),
        [releases]
    );
    const [board, setBoard] = useState<string>(
        () => releases.find((release) => release.is_current)?.board ?? boards[0]?.[0] ?? ""
    );
    const boardReleases = releases.filter((release) => release.board === board);
    const current = boardReleases.find((release) => release.is_current) ?? null;
    const [selected, setSelected] = useState<string | null>(current?.release_id ?? null);
    const shown = boardReleases.find((release) => release.release_id === selected) ?? current ?? boardReleases[0] ?? null;

    return (
        <div className="flex flex-col gap-4">
            <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
                <Stat value={current?.version ?? "—"} label="Current release" />
                <Stat value={current ? stateLabel(current) : "—"} label="Stage" />
                <Stat value={current ? current.running : "—"} label="Toys running it" />
                <Stat value={current ? rolledBack(current).length : "—"} label="Rolled back from it" />
            </div>

            <UploadPanel onUploaded={(release) => { setBoard(release.board); setSelected(release.release_id); }} />

            {boards.length > 1 && (
                <Select value={board} onValueChange={(value) => { setBoard(value); setSelected(null); }}>
                    <SelectTrigger className="w-full rounded-full sm:w-[260px]">
                        <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                        {boards.map(([key, label]) => (
                            <SelectItem key={key} value={key}>
                                {label}
                            </SelectItem>
                        ))}
                    </SelectContent>
                </Select>
            )}

            <div className="grid grid-cols-1 items-start gap-4 xl:grid-cols-[minmax(0,1.4fr)_minmax(0,1fr)]">
                <Card className="min-w-0 rounded-2xl border-0 bg-white/80 shadow-sm">
                    <CardContent className="pt-4">
                        {boardReleases.length === 0 ? (
                            <p className="text-sm text-muted-foreground">
                                No release yet. Upload a firmware.bin built from the release environment.
                            </p>
                        ) : (
                            <Table>
                                <TableHeader>
                                    <TableRow>
                                        <TableHead>Version</TableHead>
                                        <TableHead>State</TableHead>
                                        <TableHead className="text-right">Running</TableHead>
                                        <TableHead className="whitespace-nowrap text-right">Rolled back</TableHead>
                                        <TableHead className="text-right">Size</TableHead>
                                        <TableHead>Published</TableHead>
                                        <TableHead>Notes</TableHead>
                                    </TableRow>
                                </TableHeader>
                                <TableBody>
                                    {boardReleases.map((release) => (
                                        <TableRow
                                            key={release.release_id}
                                            onClick={() => setSelected(release.release_id)}
                                            className={cn("cursor-pointer", shown?.release_id === release.release_id && "bg-sky-50")}
                                        >
                                            <TableCell className="whitespace-nowrap font-mono text-xs font-medium">{release.version}</TableCell>
                                            <TableCell><StatePill release={release} /></TableCell>
                                            <TableCell className="text-right">{release.running || "—"}</TableCell>
                                            <TableCell className={cn("text-right", rolledBack(release).length > 0 && "font-medium text-rose-600")}>
                                                {rolledBack(release).length || "—"}
                                            </TableCell>
                                            <TableCell className="whitespace-nowrap text-right font-mono text-xs">{mb(release.size_bytes)}</TableCell>
                                            <TableCell className="whitespace-nowrap text-sm">{when(release.created_at)}</TableCell>
                                            <TableCell className="max-w-[260px] truncate text-sm text-muted-foreground">{release.notes ?? ""}</TableCell>
                                        </TableRow>
                                    ))}
                                </TableBody>
                            </Table>
                        )}
                    </CardContent>
                </Card>

                {shown && (
                    <ReleaseDetail
                        key={shown.release_id}
                        release={shown}
                        current={current}
                        devices={devices.filter((device) => device.firmware_board === shown.board)}
                        onOpenDevice={onOpenDevice}
                    />
                )}
            </div>
        </div>
    );
};

function UploadPanel({ onUploaded }: { onUploaded: (release: { board: string; release_id: string }) => void }) {
    const router = useRouter();
    const input = useRef<HTMLInputElement>(null);
    const [file, setFile] = useState<File | null>(null);
    const [notes, setNotes] = useState("");
    const [busy, setBusy] = useState(false);

    const upload = async () => {
        if (!file) return;
        setBusy(true);
        const form = new FormData();
        form.append("file", file);
        form.append("notes", notes);
        try {
            const response = await fetch("/api/admin/firmware", { method: "POST", body: form });
            const body = await response.json().catch(() => ({}));
            if (!response.ok) {
                toast({
                    description: body.error ?? (response.status === 413
                        ? "The server refused a file that size."
                        : `Upload failed (${response.status})`),
                    variant: "destructive",
                });
                return;
            }
            toast({ description: `${body.board} ${body.version} uploaded as a draft. No toy is offered it yet.` });
            if (body.warning) {
                toast({ description: body.warning, variant: "destructive" });
            }
            setFile(null);
            setNotes("");
            if (input.current) input.current.value = "";
            onUploaded(body);
            router.refresh();
        } finally {
            setBusy(false);
        }
    };

    return (
        <Card className="rounded-2xl border-0 bg-white/80 shadow-sm">
            <CardHeader className="pb-2">
                <CardTitle className="text-base">Upload a build</CardTitle>
                <CardDescription>
                    The firmware.bin of a release build. The board and version are read from the image; a dev
                    build, a damaged file or one too big for the board is refused.
                </CardDescription>
            </CardHeader>
            <CardContent className="flex flex-col gap-2 sm:flex-row sm:items-start">
                <Input
                    ref={input}
                    type="file"
                    accept=".bin,application/octet-stream"
                    onChange={(event) => setFile(event.target.files?.[0] ?? null)}
                    className="min-w-0 rounded-full sm:max-w-[280px]"
                />
                <Input
                    value={notes}
                    onChange={(event) => setNotes(event.target.value)}
                    placeholder="What changed (shown with the release)"
                    maxLength={2000}
                    className="min-w-0 flex-1 rounded-full"
                />
                <Button className="rounded-full" onClick={upload} disabled={!file || busy}>
                    {busy ? "Uploading…" : "Upload"}
                </Button>
            </CardContent>
        </Card>
    );
}

type Pending = {
    title: string;
    body: React.ReactNode;
    confirm: string;
    destructive?: boolean;
    needsReason?: boolean;
    run: (reason: string) => Promise<ActionResult>;
    done: string;
};

function ReleaseDetail({
    release,
    current,
    devices,
    onOpenDevice,
}: {
    release: IAdminFirmwareRelease;
    current: IAdminFirmwareRelease | null;
    devices: IAdminDevice[];
    onOpenDevice: (mac: string) => void;
}) {
    const router = useRouter();
    const [pending, setPending] = useState<Pending | null>(null);
    const [whitelist, setWhitelist] = useState<string[]>(release.rollout_macs);
    const [typed, setTyped] = useState("");
    const state = stateOf(release);
    const stage = release.rollout_percent as Stage;
    const name = `${release.board_label} ${release.version}`;
    const change = (c: FirmwareRolloutChange) => () => changeFirmwareRolloutAction(release.release_id, c);

    const failed = rolledBack(release);
    const waiting = release.rollout.filter((row) => !row.failed_at && !row.running_at).length;
    const whitelistChanged = whitelist.join() !== release.rollout_macs.join();
    const addable = devices.filter((device) => device.mac_address && !whitelist.includes(device.mac_address));

    const addTyped = () => {
        const mac = typed.trim().toUpperCase().replace(/-/g, ":");
        if (!MAC.test(mac)) {
            toast({ description: "A MAC looks like F8:5B:1B:53:62:70", variant: "destructive" });
            return;
        }
        if (!whitelist.includes(mac)) setWhitelist([...whitelist, mac].sort());
        setTyped("");
    };

    const askStage = (to: Stage) =>
        setPending({
            title: `${to > stage ? "Widen" : "Narrow"} ${release.version} to ${STAGE_LABELS[to]}`,
            body: release.is_current
                ? `It will be offered to ${release.reach[to]} toy${release.reach[to] === 1 ? "" : "s"} of this kind${to === 0 ? " (the whitelist)" : ", whitelist included"}.${to < stage ? " Toys that already took it keep it." : ""}`
                : `It is not current, so nothing is offered yet. When it is made current it starts at ${STAGE_LABELS[to]}: ${release.reach[to]} toy${release.reach[to] === 1 ? "" : "s"}.`,
            confirm: `Move to ${STAGE_LABELS[to]}`,
            run: change({ action: "stage", percent: to }),
            done: `${release.version}: ${STAGE_LABELS[to]}`,
        });

    const run = async (reason: string) => {
        if (!pending) return false;
        const result = await pending.run(reason);
        if (!result.ok) {
            toast({ description: result.error, variant: "destructive" });
            return false;
        }
        toast({ description: pending.done });
        return true;
    };

    const deleteDraft = async (): Promise<ActionResult> => {
        const response = await fetch(`/api/admin/firmware?release_id=${release.release_id}`, { method: "DELETE" });
        if (response.ok) {
            router.refresh();
            return { ok: true };
        }
        const body = await response.json().catch(() => ({}));
        return { ok: false, error: body.error ?? `Could not delete it (${response.status})` };
    };

    return (
        <Card className="min-w-0 rounded-2xl border-0 bg-white/80 shadow-sm">
            <CardHeader className="pb-2">
                <CardTitle className="flex flex-wrap items-center gap-2 text-base">
                    {release.version} <StatePill release={release} />
                </CardTitle>
                <CardDescription>{release.notes || "No notes."}</CardDescription>
            </CardHeader>
            <CardContent className="flex flex-col gap-4">
                {release.paused_at && (
                    <p className="rounded-xl bg-rose-50 px-3 py-2 text-sm text-rose-800 ring-1 ring-rose-200">
                        Paused {when(release.paused_at)} {release.paused_by ? "by an admin" : "by the server"}:{" "}
                        {release.paused_reason}. No toy is offered it until it is resumed.
                    </p>
                )}

                <dl className="grid grid-cols-[max-content_minmax(0,1fr)] gap-x-4 gap-y-1.5 text-sm">
                    <dt className="text-muted-foreground">Board</dt>
                    <dd>{release.board_label}</dd>
                    <dt className="text-muted-foreground">Published</dt>
                    <dd>{when(release.created_at)}</dd>
                    <dt className="text-muted-foreground">Stage changed</dt>
                    <dd>{when(release.stage_changed_at)}</dd>
                    <dt className="text-muted-foreground">SHA-256</dt>
                    <dd className="break-all font-mono text-xs leading-5">{release.sha256}</dd>
                    <dt className="text-muted-foreground">Offered to</dt>
                    <dd>
                        {release.rollout.length} toy{release.rollout.length === 1 ? "" : "s"}
                        {waiting > 0 && <span className="text-muted-foreground"> · {waiting} not reported back yet</span>}
                    </dd>
                </dl>

                {release.app_slot && <PartitionMeter release={release} />}

                <div>
                    <h4 className="mb-1.5 text-sm font-semibold text-gray-900">Stage</h4>
                    <div className="grid grid-cols-2 gap-1.5 sm:grid-cols-4">
                        {STAGES.map((percent) => {
                            const here = percent === stage;
                            return (
                                <button
                                    key={percent}
                                    type="button"
                                    disabled={here}
                                    onClick={() => askStage(percent)}
                                    className={cn(
                                        "rounded-xl px-3 py-2 text-left text-xs transition-colors",
                                        here && release.is_current && "bg-sky-50 text-[#2a78cf] ring-1 ring-[#2a78cf]",
                                        here && !release.is_current && "bg-gray-100 text-gray-700 ring-1 ring-gray-300",
                                        !here && "bg-gray-50 text-gray-500 hover:bg-sky-50"
                                    )}
                                >
                                    <div className="text-sm font-medium text-gray-900">{STAGE_LABELS[percent]}</div>
                                    {release.reach[percent]} toy{release.reach[percent] === 1 ? "" : "s"}
                                </button>
                            );
                        })}
                    </div>
                    <p className="mt-1.5 text-xs text-muted-foreground">
                        Counted from the toys that have reported this board. A toy keeps its group at every stage.
                    </p>
                </div>

                <div className="flex flex-wrap gap-2">
                    {!release.is_current && (
                        <Button
                            className="rounded-full"
                            onClick={() =>
                                setPending({
                                    title: `Make ${release.version} current`,
                                    body: `It starts at ${STAGE_LABELS[stage]}: offered to ${release.reach[stage]} toy${release.reach[stage] === 1 ? "" : "s"} on their next boot.${current ? ` ${current.version} stops being offered; toys that took it keep it.` : ""}`,
                                    confirm: "Make current",
                                    run: change({ action: "current" }),
                                    done: `${release.version} is current at ${STAGE_LABELS[stage]}`,
                                })
                            }
                        >
                            Make current
                        </Button>
                    )}
                    {release.is_current && stage < 100 && !release.paused_at && (
                        <Button className="rounded-full" onClick={() => askStage(STAGES[STAGES.indexOf(stage) + 1])}>
                            Widen to {STAGE_LABELS[STAGES[STAGES.indexOf(stage) + 1]]}
                        </Button>
                    )}
                    {release.is_current && !release.paused_at && (
                        <Button
                            variant="outline"
                            className="rounded-full"
                            onClick={() =>
                                setPending({
                                    title: `Pause ${release.version}`,
                                    body: "No toy is offered it until it is resumed. Toys that took it keep it.",
                                    confirm: "Pause",
                                    destructive: true,
                                    needsReason: true,
                                    run: (reason) => changeFirmwareRolloutAction(release.release_id, { action: "pause", reason }),
                                    done: `${release.version} paused`,
                                })
                            }
                        >
                            Pause
                        </Button>
                    )}
                    {release.paused_at && (
                        <Button
                            className="rounded-full"
                            onClick={() =>
                                setPending({
                                    title: `Resume ${release.version}`,
                                    body: `It is offered again at ${STAGE_LABELS[stage]}. If another toy rolls back and more than 5% have, the server pauses it again.`,
                                    confirm: "Resume",
                                    run: change({ action: "resume" }),
                                    done: `${release.version} resumed`,
                                })
                            }
                        >
                            Resume
                        </Button>
                    )}
                    {release.is_current && (
                        <Button
                            variant="outline"
                            className="rounded-full"
                            onClick={() =>
                                setPending({
                                    title: `Withdraw ${release.version}`,
                                    body: `It stops being current. Toys that took it keep it, and no ${release.board_label} is offered any update until another release is made current.`,
                                    confirm: "Withdraw",
                                    destructive: true,
                                    run: change({ action: "withdraw" }),
                                    done: `${release.version} withdrawn`,
                                })
                            }
                        >
                            Withdraw
                        </Button>
                    )}
                    {state === "draft" && (
                        <Button
                            variant="outline"
                            className="rounded-full text-rose-700"
                            onClick={() =>
                                setPending({
                                    title: `Delete ${release.version}`,
                                    body: "The draft and its image are deleted. It was never offered to a toy.",
                                    confirm: "Delete",
                                    destructive: true,
                                    run: deleteDraft,
                                    done: `${release.version} deleted`,
                                })
                            }
                        >
                            Delete draft
                        </Button>
                    )}
                </div>

                <div>
                    <h4 className="mb-1.5 text-sm font-semibold text-gray-900">Whitelist</h4>
                    <p className="mb-2 text-xs text-muted-foreground">
                        Offered the release at every stage: the toys on the desk, then the families who agreed to try it first.
                    </p>
                    <div className="mb-2 flex flex-wrap gap-1.5">
                        {whitelist.length === 0 && <span className="text-sm text-muted-foreground">Nobody yet.</span>}
                        {whitelist.map((mac) => (
                            <span key={mac} className="inline-flex items-center gap-1 rounded-full bg-gray-100 py-0.5 pl-2.5 pr-1 text-xs">
                                <span className="font-medium">{deviceName(mac)}</span>
                                <span className="font-mono text-[10px] text-muted-foreground">{mac}</span>
                                <button
                                    type="button"
                                    aria-label={`Remove ${mac}`}
                                    onClick={() => setWhitelist(whitelist.filter((entry) => entry !== mac))}
                                    className="rounded-full px-1.5 text-gray-500 hover:bg-gray-200 hover:text-gray-900"
                                >
                                    ×
                                </button>
                            </span>
                        ))}
                    </div>
                    <div className="flex flex-col gap-2 sm:flex-row">
                        {addable.length > 0 && (
                            <Select value="" onValueChange={(mac) => setWhitelist([...whitelist, mac].sort())}>
                                <SelectTrigger className="min-w-0 rounded-full sm:w-[200px]">
                                    <SelectValue placeholder="Add a toy" />
                                </SelectTrigger>
                                <SelectContent>
                                    {addable.map((device) => (
                                        <SelectItem key={device.device_id} value={device.mac_address as string}>
                                            {deviceName(device.mac_address)} · {device.firmware_version ?? "?"}
                                        </SelectItem>
                                    ))}
                                </SelectContent>
                            </Select>
                        )}
                        <div className="flex min-w-0 flex-1 gap-2">
                            <Input
                                value={typed}
                                onChange={(event) => setTyped(event.target.value)}
                                onKeyDown={(event) => event.key === "Enter" && addTyped()}
                                placeholder="or a MAC"
                                className="min-w-0 flex-1 rounded-full font-mono text-xs"
                            />
                            <Button variant="outline" className="rounded-full" onClick={addTyped} disabled={!typed.trim()}>
                                Add
                            </Button>
                        </div>
                    </div>
                    {whitelistChanged && (
                        <div className="mt-2 flex gap-2">
                            <Button
                                className="rounded-full"
                                onClick={() =>
                                    setPending({
                                        title: `Save the whitelist of ${release.version}`,
                                        body: `${whitelist.length} toy${whitelist.length === 1 ? "" : "s"}${release.is_current && !release.paused_at ? "; the ones added are offered it on their next boot" : ""}.`,
                                        confirm: "Save",
                                        run: change({ action: "whitelist", macs: whitelist }),
                                        done: `${release.version}: whitelist saved`,
                                    })
                                }
                            >
                                Save whitelist
                            </Button>
                            <Button variant="ghost" className="rounded-full" onClick={() => setWhitelist(release.rollout_macs)}>
                                Undo
                            </Button>
                        </div>
                    )}
                </div>

                <div>
                    <h4 className="mb-1.5 text-sm font-semibold text-gray-900">Rolled back ({failed.length})</h4>
                    {failed.length === 0 ? (
                        <p className="text-sm text-muted-foreground">No toy has rolled back from {release.version}.</p>
                    ) : (
                        <ul className="flex flex-col divide-y divide-gray-100 text-sm">
                            {failed.map((row) => (
                                <li key={row.device_id} className="flex items-center justify-between gap-2 py-1.5">
                                    <button
                                        type="button"
                                        className="min-w-0 text-left hover:underline"
                                        onClick={() => row.mac_address && onOpenDevice(row.mac_address)}
                                    >
                                        <span className="font-medium">{deviceName(row.mac_address)}</span>{" "}
                                        <span className="font-mono text-[11px] text-muted-foreground">{row.mac_address}</span>
                                    </button>
                                    <span className="shrink-0 text-xs text-muted-foreground">{when(row.failed_at)}</span>
                                </li>
                            ))}
                        </ul>
                    )}
                </div>
            </CardContent>

            <ConfirmDialog
                pending={pending}
                onClose={() => setPending(null)}
                run={run}
                name={name}
            />
        </Card>
    );
}

function PartitionMeter({ release }: { release: IAdminFirmwareRelease }) {
    const slot = release.app_slot as number;
    const percent = (release.size_bytes / slot) * 100;
    const overLegacy = release.legacy_app_slot !== null && release.size_bytes > release.legacy_app_slot;
    return (
        <div>
            <h4 className="mb-1.5 text-sm font-semibold text-gray-900">App partition</h4>
            <div className="h-2 overflow-hidden rounded-full bg-gray-100">
                <div
                    className={cn("h-full rounded-full", percent > 90 ? "bg-rose-500" : percent > 75 ? "bg-amber-500" : "bg-emerald-500")}
                    style={{ width: `${Math.min(100, percent)}%` }}
                />
            </div>
            <p className="mt-1.5 text-sm">
                <span className="font-medium">{mb(release.size_bytes)} of {mb(slot)}</span>{" "}
                <span className="text-muted-foreground">· {percent.toFixed(1)}%</span>
            </p>
            {overLegacy && (
                <p className="mt-1 text-xs text-amber-800">
                    Over the {mb(release.legacy_app_slot as number)} slot of toys flashed before the new partition table:
                    those toys cannot install it.
                </p>
            )}
        </div>
    );
}

function ConfirmDialog({
    pending,
    onClose,
    run,
    name,
}: {
    pending: Pending | null;
    onClose: () => void;
    run: (reason: string) => Promise<boolean>;
    name: string;
}) {
    const [reason, setReason] = useState("");
    const [busy, setBusy] = useState(false);

    const submit = async () => {
        setBusy(true);
        const ok = await run(reason);
        setBusy(false);
        if (ok) {
            setReason("");
            onClose();
        }
    };

    return (
        <Dialog open={pending !== null} onOpenChange={(open) => !open && !busy && onClose()}>
            {pending && (
                <DialogContent className="max-w-md">
                    <DialogHeader>
                        <DialogTitle>{pending.title}</DialogTitle>
                        <DialogDescription>
                            {name}. {pending.body} This goes to the audit log.
                        </DialogDescription>
                    </DialogHeader>
                    {pending.needsReason && (
                        <Textarea
                            value={reason}
                            onChange={(event) => setReason(event.target.value)}
                            placeholder="Reason (shown on the release and in the audit log)"
                            maxLength={500}
                            rows={3}
                            autoFocus
                        />
                    )}
                    <DialogFooter className="gap-2">
                        <Button variant="outline" className="rounded-full" onClick={onClose} disabled={busy}>
                            Cancel
                        </Button>
                        <Button
                            variant={pending.destructive ? "destructive" : "default"}
                            className="rounded-full"
                            onClick={submit}
                            disabled={busy || (pending.needsReason === true && reason.trim() === "")}
                        >
                            {busy ? "Working…" : pending.confirm}
                        </Button>
                    </DialogFooter>
                </DialogContent>
            )}
        </Dialog>
    );
}

function StatePill({ release }: { release: IAdminFirmwareRelease }) {
    return (
        <span
            className={cn(
                "inline-flex items-center whitespace-nowrap rounded-full px-2 py-0.5 text-xs font-medium ring-1",
                STATE_STYLES[stateOf(release)]
            )}
        >
            {stateLabel(release)}
        </span>
    );
}

function Stat({ value, label }: { value: React.ReactNode; label: string }) {
    return (
        <div className="rounded-2xl bg-white/80 px-4 py-3 shadow-sm">
            <div className="font-fredoka text-2xl font-semibold text-gray-900">{value}</div>
            <div className="text-xs text-muted-foreground">{label}</div>
        </div>
    );
}

export default OtaTab;
