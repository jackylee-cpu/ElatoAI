"use client";

import React, { useMemo, useState } from "react";
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
import { cn } from "@/lib/utils";

const ALL = "__all__";
// The service role, a migration or psql: anything without an admin's key.
const SYSTEM = "__system__";

// What each audited table is, in the words of the page that edits it.
const TABLE_LABELS: Record<string, string> = {
    app_settings: "Setting",
    personalities: "Character",
    ips: "IP",
    ip_modes: "IP activity",
    ip_styles: "IP style",
    admin_roles: "Admin role",
    "auth.users": "Account",
};

const VERBS: Record<string, string> = {
    insert: "Added",
    update: "Changed",
    delete: "Removed",
    "account.create": "Created",
};

function describe(entry: IAdminAuditEntry): string {
    const verb = VERBS[entry.action] ?? entry.action;
    const thing = TABLE_LABELS[entry.target_table ?? ""] ?? entry.target_table ?? "";
    return `${verb} ${thing.toLowerCase()}`.trim();
}

function who(entry: IAdminAuditEntry): string {
    return entry.actor_email ?? (entry.actor_id ? entry.actor_id.slice(0, 8) : "System");
}

interface AuditTabProps {
    entries: IAdminAuditEntry[];
}

/**
 * Who changed what, when and why (P1-10). Super admins only -- the page does
 * not render this for anyone else, and RLS returns them nothing. The log
 * itself cannot be edited from here or anywhere: the database refuses every
 * UPDATE and DELETE on it.
 */
const AuditTab: React.FC<AuditTabProps> = ({ entries }) => {
    const [actor, setActor] = useState(ALL);
    const [table, setTable] = useState(ALL);
    const [selected, setSelected] = useState<number | null>(entries[0]?.audit_id ?? null);

    const actors = useMemo(
        () => Array.from(new Set(entries.filter((e) => e.actor_id).map(who))).sort(),
        [entries]
    );
    const tables = useMemo(
        () => Array.from(new Set(entries.map((e) => e.target_table ?? ""))).filter(Boolean).sort(),
        [entries]
    );

    const filtered = entries.filter(
        (entry) =>
            (actor === ALL ||
                (actor === SYSTEM ? entry.actor_id === null : who(entry) === actor)) &&
            (table === ALL || entry.target_table === table)
    );
    const current = filtered.find((entry) => entry.audit_id === selected) ?? filtered[0] ?? null;

    return (
        <div className="flex flex-col gap-4">
            <div className="flex flex-wrap items-center gap-2">
                <Select value={actor} onValueChange={setActor}>
                    <SelectTrigger className="w-[220px]">
                        <SelectValue placeholder="All admins" />
                    </SelectTrigger>
                    <SelectContent>
                        <SelectItem value={ALL}>All admins</SelectItem>
                        {actors.map((name) => (
                            <SelectItem key={name} value={name}>
                                {name}
                            </SelectItem>
                        ))}
                        <SelectItem value={SYSTEM}>System (no admin key)</SelectItem>
                    </SelectContent>
                </Select>
                <Select value={table} onValueChange={setTable}>
                    <SelectTrigger className="w-[180px]">
                        <SelectValue placeholder="Everything" />
                    </SelectTrigger>
                    <SelectContent>
                        <SelectItem value={ALL}>Everything</SelectItem>
                        {tables.map((name) => (
                            <SelectItem key={name} value={name}>
                                {TABLE_LABELS[name] ?? name}
                            </SelectItem>
                        ))}
                    </SelectContent>
                </Select>
                <span className="text-xs text-muted-foreground">
                    {filtered.length} of the latest {entries.length} records
                </span>
            </div>

            <div className="grid grid-cols-1 items-start gap-4 xl:grid-cols-[minmax(0,1.4fr)_minmax(0,1fr)]">
                <Card className="min-w-0 rounded-2xl border-0 bg-white/80 shadow-sm">
                    <CardContent className="pt-4">
                        {filtered.length === 0 ? (
                            <p className="text-sm text-muted-foreground">
                                Nothing recorded yet. Every change made on these admin pages will show up here.
                            </p>
                        ) : (
                            <Table>
                                <TableHeader>
                                    <TableRow>
                                        <TableHead>When</TableHead>
                                        <TableHead>Who</TableHead>
                                        <TableHead>What</TableHead>
                                        <TableHead>Target</TableHead>
                                    </TableRow>
                                </TableHeader>
                                <TableBody>
                                    {filtered.map((entry) => (
                                        <TableRow
                                            key={entry.audit_id}
                                            onClick={() => setSelected(entry.audit_id)}
                                            className={cn(
                                                "cursor-pointer",
                                                current?.audit_id === entry.audit_id && "bg-sky-50"
                                            )}
                                        >
                                            <TableCell className="whitespace-nowrap text-xs text-muted-foreground">
                                                {new Date(entry.created_at).toLocaleString()}
                                            </TableCell>
                                            <TableCell className="whitespace-nowrap text-sm">{who(entry)}</TableCell>
                                            <TableCell className="whitespace-nowrap text-sm">{describe(entry)}</TableCell>
                                            <TableCell className="max-w-[220px] truncate text-sm">
                                                {entry.target_label ?? entry.target_id ?? "—"}
                                            </TableCell>
                                        </TableRow>
                                    ))}
                                </TableBody>
                            </Table>
                        )}
                    </CardContent>
                </Card>

                {current && <AuditDetail entry={current} />}
            </div>
        </div>
    );
};

function AuditDetail({ entry }: { entry: IAdminAuditEntry }) {
    const keys = Array.from(
        new Set([...Object.keys(entry.before ?? {}), ...Object.keys(entry.after ?? {})])
    ).sort();

    return (
        <Card className="min-w-0 rounded-2xl border-0 bg-white/80 shadow-sm">
            <CardHeader className="pb-2">
                <CardTitle className="text-base">{describe(entry)}</CardTitle>
                <CardDescription>
                    {new Date(entry.created_at).toLocaleString()} · {who(entry)}
                </CardDescription>
            </CardHeader>
            <CardContent className="flex flex-col gap-3">
                <dl className="grid grid-cols-[max-content_minmax(0,1fr)] gap-x-4 gap-y-1 text-sm">
                    <dt className="text-muted-foreground">Target</dt>
                    <dd className="break-words">{entry.target_label ?? "—"}</dd>
                    <dt className="text-muted-foreground">Id</dt>
                    <dd className="break-all font-mono text-xs">{entry.target_id ?? "—"}</dd>
                    {entry.reason && (
                        <>
                            <dt className="text-muted-foreground">Reason</dt>
                            <dd className="break-words">{entry.reason}</dd>
                        </>
                    )}
                </dl>
                <div className="overflow-hidden rounded-xl border border-gray-100 font-mono text-xs">
                    {keys.length === 0 && <div className="px-3 py-2 text-muted-foreground">No values recorded.</div>}
                    {keys.map((key) => (
                        <div key={key} className="border-b border-gray-100 last:border-0">
                            <div className="bg-gray-50 px-3 py-1 text-[11px] text-muted-foreground">{key}</div>
                            {entry.before && key in entry.before && (
                                <div className="whitespace-pre-wrap break-words bg-rose-50 px-3 py-1.5 text-rose-700">
                                    - {show(entry.before[key])}
                                </div>
                            )}
                            {entry.after && key in entry.after && (
                                <div className="whitespace-pre-wrap break-words bg-emerald-50 px-3 py-1.5 text-emerald-700">
                                    + {show(entry.after[key])}
                                </div>
                            )}
                        </div>
                    ))}
                </div>
            </CardContent>
        </Card>
    );
}

function show(value: unknown): string {
    if (value === null || value === undefined) return "null";
    if (typeof value === "string") return value;
    return JSON.stringify(value, null, 2);
}

export default AuditTab;
