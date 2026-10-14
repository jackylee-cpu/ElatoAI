"use client";

import React, { useMemo, useState } from "react";
import { Copy, MoreHorizontal, RefreshCw } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import {
    Dialog,
    DialogContent,
    DialogDescription,
    DialogFooter,
    DialogHeader,
    DialogTitle,
} from "@/components/ui/dialog";
import {
    DropdownMenu,
    DropdownMenuContent,
    DropdownMenuItem,
    DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
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
import {
    createAccountAction,
    deleteAccountAction,
    updateAccountAction,
} from "@/app/admin/actions";
import { MIN_PASSWORD_LENGTH } from "@/lib/passwords";

type RoleChoice = "none" | AdminRole;
type StatusChoice = "active" | "unconfirmed" | "disabled";
type StatusFilter = "all" | StatusChoice;
type RoleFilter = "all" | "none" | AdminRole;

interface AccountRow extends IAccountEntry {
    roles: AdminRole[];
}

interface AccountsTabProps {
    accounts: IAccountEntry[];
    admins: IAdminRoleEntry[];
    currentUserId: string;
}

const ROLE_LABELS: Record<AdminRole, string> = {
    super_admin: "Super admin",
    content_admin: "Content admin",
};

const STATUS_LABELS: Record<StatusChoice, string> = {
    active: "Active",
    unconfirmed: "Email not confirmed",
    disabled: "Disabled",
};

// No 0/O, 1/l/I: the password is read out or typed from a note.
const PASSWORD_ALPHABET = "abcdefghijkmnpqrstuvwxyzABCDEFGHJKLMNPQRSTUVWXYZ23456789";
const GENERATED_LENGTH = 12;

function generatePassword(): string {
    const bytes = new Uint32Array(GENERATED_LENGTH);
    crypto.getRandomValues(bytes);
    return Array.from(bytes, (n) => PASSWORD_ALPHABET[n % PASSWORD_ALPHABET.length]).join("");
}

function formatDate(value: string | null): string {
    return value ? new Date(value).toLocaleString() : "Never";
}

function isDisabled(until: string | null): boolean {
    if (!until) return false;
    const time = new Date(until).getTime();
    return Number.isFinite(time) && time > Date.now();
}

function accountStatus(account: IAccountEntry): StatusChoice {
    if (isDisabled(account.banned_until)) return "disabled";
    if (!account.confirmed) return "unconfirmed";
    return "active";
}

/** Super admin wins when an account holds both; that is what the form shows. */
function primaryRole(roles: AdminRole[]): RoleChoice {
    if (roles.includes("super_admin")) return "super_admin";
    if (roles.includes("content_admin")) return "content_admin";
    return "none";
}

/**
 * Logins: create one, change it, or remove it. Super admins only -- the page
 * does not render this for anyone else, and each action checks again.
 * The three filters apply together.
 */
const AccountsTab: React.FC<AccountsTabProps> = ({ accounts, admins, currentUserId }) => {
    const [query, setQuery] = useState("");
    const [status, setStatus] = useState<StatusFilter>("all");
    const [role, setRole] = useState<RoleFilter>("all");
    const [editor, setEditor] = useState<
        { kind: "create" } | { kind: "edit"; account: AccountRow } | null
    >(null);
    const [removing, setRemoving] = useState<AccountRow | null>(null);
    // Shown once after a password is set, so the admin can pass it on.
    const [created, setCreated] = useState<{ email: string; password: string } | null>(null);

    const rows = useMemo<AccountRow[]>(() => {
        const byUser = new Map<string, AdminRole[]>();
        for (const entry of admins) {
            const held = byUser.get(entry.user_id) ?? [];
            held.push(entry.role);
            byUser.set(entry.user_id, held);
        }
        return accounts.map((account) => ({
            ...account,
            roles: byUser.get(account.user_id) ?? [],
        }));
    }, [accounts, admins]);

    const shown = useMemo(() => {
        const needle = query.trim().toLowerCase();
        return rows.filter((account) => {
            if (status !== "all" && accountStatus(account) !== status) return false;
            if (role === "none" && account.roles.length > 0) return false;
            if (role !== "all" && role !== "none" && !account.roles.includes(role)) return false;
            if (!needle) return true;
            return account.email.toLowerCase().includes(needle);
        });
    }, [rows, query, status, role]);

    return (
        <div className="flex flex-col gap-4">
            {created && (
                <div className="flex flex-row flex-wrap items-center justify-between gap-2 rounded-xl border border-green-200 bg-green-50 px-3 py-2 text-sm">
                    <span className="font-mono">
                        {created.email} / {created.password}
                    </span>
                    <div className="flex flex-row gap-1">
                        <Button type="button" variant="ghost" size="sm" onClick={() => copyLogin(created)}>
                            <Copy className="mr-1 h-3.5 w-3.5" /> Copy
                        </Button>
                        <Button type="button" variant="ghost" size="sm" onClick={() => setCreated(null)}>
                            Hide
                        </Button>
                    </div>
                </div>
            )}

            <div className="flex flex-wrap items-center gap-2">
                <Input
                    type="search"
                    value={query}
                    onChange={(event) => setQuery(event.target.value)}
                    placeholder="Filter by email"
                    aria-label="Filter by email"
                    className="min-w-0 flex-1 basis-60 rounded-full"
                />
                <div className="flex w-full gap-2 sm:w-auto">
                    <Select value={status} onValueChange={(value) => setStatus(value as StatusFilter)}>
                        <SelectTrigger className="min-w-0 flex-1 rounded-full sm:w-[200px] sm:flex-none" aria-label="Filter by status">
                            <SelectValue />
                        </SelectTrigger>
                        <SelectContent>
                            <SelectItem value="all">All statuses</SelectItem>
                            <SelectItem value="active">Active</SelectItem>
                            <SelectItem value="unconfirmed">Email not confirmed</SelectItem>
                            <SelectItem value="disabled">Disabled</SelectItem>
                        </SelectContent>
                    </Select>
                    <Select value={role} onValueChange={(value) => setRole(value as RoleFilter)}>
                        <SelectTrigger className="min-w-0 flex-1 rounded-full sm:w-[180px] sm:flex-none" aria-label="Filter by role">
                            <SelectValue />
                        </SelectTrigger>
                        <SelectContent>
                            <SelectItem value="all">All roles</SelectItem>
                            <SelectItem value="super_admin">Super admin</SelectItem>
                            <SelectItem value="content_admin">Content admin</SelectItem>
                            <SelectItem value="none">No admin role</SelectItem>
                        </SelectContent>
                    </Select>
                </div>
                <Button type="button" className="rounded-full sm:ml-auto" onClick={() => setEditor({ kind: "create" })}>
                    New account
                </Button>
            </div>

            <Card className="min-w-0 rounded-2xl border-0 bg-white/80 shadow-sm">
                <CardContent className="overflow-x-auto pt-4">
                    <Table>
                        <TableHeader>
                            <TableRow>
                                <TableHead>Email</TableHead>
                                <TableHead>Role</TableHead>
                                <TableHead>Created</TableHead>
                                <TableHead>Last log in</TableHead>
                                <TableHead>Status</TableHead>
                                <TableHead className="w-12" />
                            </TableRow>
                        </TableHeader>
                        <TableBody>
                            {shown.map((account) => {
                                const mine = account.user_id === currentUserId;
                                return (
                                    <TableRow
                                        key={account.user_id}
                                        className="cursor-pointer"
                                        onClick={() => setEditor({ kind: "edit", account })}
                                    >
                                        <TableCell className="text-sm">
                                            {account.email}
                                            {mine && (
                                                <span className="ml-2 text-xs text-muted-foreground">You</span>
                                            )}
                                        </TableCell>
                                        <TableCell>
                                            {account.roles.length === 0 ? (
                                                <span className="text-sm text-muted-foreground">—</span>
                                            ) : (
                                                <span className="flex flex-wrap gap-1">
                                                    {account.roles.map((held) => (
                                                        <Badge key={held} variant="outline">
                                                            {ROLE_LABELS[held]}
                                                        </Badge>
                                                    ))}
                                                </span>
                                            )}
                                        </TableCell>
                                        <TableCell className="whitespace-nowrap text-xs text-muted-foreground" suppressHydrationWarning>
                                            {formatDate(account.created_at)}
                                        </TableCell>
                                        <TableCell className="whitespace-nowrap text-xs text-muted-foreground" suppressHydrationWarning>
                                            {formatDate(account.last_sign_in_at)}
                                        </TableCell>
                                        <TableCell>
                                            <StatusBadge status={accountStatus(account)} />
                                        </TableCell>
                                        <TableCell onClick={(event) => event.stopPropagation()}>
                                            <DropdownMenu>
                                                <DropdownMenuTrigger asChild>
                                                    <Button
                                                        type="button"
                                                        variant="ghost"
                                                        size="icon"
                                                        className="h-8 w-8"
                                                        aria-label={`Actions for ${account.email}`}
                                                    >
                                                        <MoreHorizontal className="h-4 w-4" />
                                                    </Button>
                                                </DropdownMenuTrigger>
                                                <DropdownMenuContent align="end">
                                                    <DropdownMenuItem
                                                        onSelect={() => setEditor({ kind: "edit", account })}
                                                    >
                                                        Edit
                                                    </DropdownMenuItem>
                                                    <DropdownMenuItem
                                                        disabled={mine}
                                                        className="text-rose-700 focus:bg-rose-50 focus:text-rose-800"
                                                        title={
                                                            mine
                                                                ? "You cannot delete the account you are signed in with"
                                                                : undefined
                                                        }
                                                        onSelect={() => setRemoving(account)}
                                                    >
                                                        Delete
                                                    </DropdownMenuItem>
                                                </DropdownMenuContent>
                                            </DropdownMenu>
                                        </TableCell>
                                    </TableRow>
                                );
                            })}
                            {shown.length === 0 && (
                                <TableRow>
                                    <TableCell colSpan={6} className="text-center text-sm text-muted-foreground">
                                        {rows.length === 0 ? "No accounts yet." : "No accounts match."}
                                    </TableCell>
                                </TableRow>
                            )}
                        </TableBody>
                    </Table>
                    <p className="mt-2 text-xs text-muted-foreground">
                        Showing {shown.length} of {rows.length}.
                    </p>
                </CardContent>
            </Card>

            {editor && (
                <AccountFormDialog
                    key={editor.kind === "edit" ? editor.account.user_id : "create"}
                    mode={editor.kind}
                    account={editor.kind === "edit" ? editor.account : null}
                    isSelf={editor.kind === "edit" && editor.account.user_id === currentUserId}
                    onClose={() => setEditor(null)}
                    onIssued={(login) => setCreated(login)}
                />
            )}

            {removing && (
                <DeleteAccountDialog
                    key={removing.user_id}
                    account={removing}
                    onClose={() => setRemoving(null)}
                    onDeleted={() =>
                        setCreated((current) =>
                            current?.email === removing.email ? null : current
                        )
                    }
                />
            )}
        </div>
    );
};

async function copyLogin(login: { email: string; password: string }) {
    try {
        await navigator.clipboard.writeText(`Email: ${login.email}\nPassword: ${login.password}`);
        toast({ title: "Copied" });
    } catch {
        toast({ title: "Could not copy -- select the text instead" });
    }
}

function StatusBadge({ status }: { status: StatusChoice }) {
    if (status === "disabled") {
        return (
            <Badge variant="outline" className="border-rose-200 bg-rose-50 text-rose-700">
                Disabled
            </Badge>
        );
    }
    if (status === "unconfirmed") {
        return <Badge variant="secondary">Email not confirmed</Badge>;
    }
    return <Badge variant="outline">Active</Badge>;
}

function AccountFormDialog({
    mode,
    account,
    isSelf,
    onClose,
    onIssued,
}: {
    mode: "create" | "edit";
    account: AccountRow | null;
    isSelf: boolean;
    onClose: () => void;
    onIssued: (login: { email: string; password: string }) => void;
}) {
    const [email, setEmail] = useState(account?.email ?? "");
    const [password, setPassword] = useState(() => (mode === "create" ? generatePassword() : ""));
    const [role, setRole] = useState<RoleChoice>(account ? primaryRole(account.roles) : "none");
    const [status, setStatus] = useState<StatusChoice>(account ? accountStatus(account) : "active");
    const [busy, setBusy] = useState(false);

    const statusOptions: StatusChoice[] = account && !account.confirmed
        ? ["active", "unconfirmed", "disabled"]
        : ["active", "disabled"];

    const onSubmit = async (event: React.FormEvent) => {
        event.preventDefault();
        setBusy(true);
        if (mode === "create") {
            const result = await createAccountAction(email, password, role === "none" ? null : role);
            setBusy(false);
            if (!result.ok) {
                toast({ title: "Could not create the account", description: result.error });
                return;
            }
            onIssued({ email: email.trim().toLowerCase(), password });
            onClose();
            toast({
                title: "Account created",
                description: result.roleError,
            });
            return;
        }
        if (!account) return;
        const result = await updateAccountAction(
            account.user_id,
            email,
            password,
            role === "none" ? null : role,
            status,
        );
        setBusy(false);
        if (!result.ok) {
            toast({ title: "Could not save the account", description: result.error });
            return;
        }
        if (password) onIssued({ email: email.trim().toLowerCase(), password });
        onClose();
        toast({ title: "Account saved", description: result.roleError });
    };

    return (
        <Dialog open onOpenChange={(open) => !open && !busy && onClose()}>
            <DialogContent className="max-w-md">
                <DialogHeader>
                    <DialogTitle>{mode === "create" ? "New account" : "Edit account"}</DialogTitle>
                    <DialogDescription>
                        {mode === "create"
                            ? "They can log in straight away -- no confirmation email is sent. Give them the email and password yourself."
                            : isSelf
                                ? "This is the account you are signed in with, so its role and status stay as they are. A new password is shown once."
                                : "Leave the password blank to keep the current one. A new password is shown once, so you can pass it on."}
                    </DialogDescription>
                </DialogHeader>
                <form onSubmit={onSubmit} className="flex flex-col gap-3">
                    <label className="flex flex-col gap-1 text-sm">
                        Email
                        <Input
                            type="email"
                            value={email}
                            onChange={(event) => setEmail(event.target.value)}
                            autoComplete="off"
                            required
                        />
                    </label>
                    <label className="flex flex-col gap-1 text-sm">
                        {mode === "create" ? "Password" : "New password"}
                        <div className="flex flex-row items-center gap-1">
                            <Input
                                type="text"
                                aria-label={mode === "create" ? "Password" : "New password"}
                                value={password}
                                onChange={(event) => setPassword(event.target.value)}
                                className="font-mono"
                                minLength={password ? MIN_PASSWORD_LENGTH : undefined}
                                autoComplete="off"
                                placeholder={mode === "edit" ? "Leave blank to keep it" : undefined}
                                required={mode === "create"}
                            />
                            <Button
                                type="button"
                                variant="ghost"
                                size="icon"
                                aria-label="Generate a new password"
                                title="Generate a new password"
                                onClick={() => setPassword(generatePassword())}
                            >
                                <RefreshCw className="h-4 w-4" />
                            </Button>
                        </div>
                    </label>
                    <label className="flex flex-col gap-1 text-sm">
                        Admin role
                        <Select
                            value={role}
                            onValueChange={(value) => setRole(value as RoleChoice)}
                            disabled={isSelf}
                        >
                            <SelectTrigger>
                                <SelectValue />
                            </SelectTrigger>
                            <SelectContent>
                                <SelectItem value="none">No admin role</SelectItem>
                                <SelectItem value="content_admin">Content admin</SelectItem>
                                <SelectItem value="super_admin">Super admin</SelectItem>
                            </SelectContent>
                        </Select>
                    </label>
                    {mode === "edit" && (
                        <label className="flex flex-col gap-1 text-sm">
                            Status
                            <Select
                                value={status}
                                onValueChange={(value) => setStatus(value as StatusChoice)}
                                disabled={isSelf}
                            >
                                <SelectTrigger>
                                    <SelectValue />
                                </SelectTrigger>
                                <SelectContent>
                                    {statusOptions.map((option) => (
                                        <SelectItem key={option} value={option}>
                                            {STATUS_LABELS[option]}
                                        </SelectItem>
                                    ))}
                                </SelectContent>
                            </Select>
                        </label>
                    )}
                    <DialogFooter className="gap-2">
                        <Button type="button" variant="outline" className="rounded-full" onClick={onClose} disabled={busy}>
                            Cancel
                        </Button>
                        <Button type="submit" className="rounded-full" disabled={busy}>
                            {busy ? "Saving..." : mode === "create" ? "Create" : "Save"}
                        </Button>
                    </DialogFooter>
                </form>
            </DialogContent>
        </Dialog>
    );
}

function DeleteAccountDialog({
    account,
    onClose,
    onDeleted,
}: {
    account: AccountRow;
    onClose: () => void;
    onDeleted: () => void;
}) {
    const [reason, setReason] = useState("");
    const [busy, setBusy] = useState(false);

    const submit = async () => {
        setBusy(true);
        const result = await deleteAccountAction(account.user_id, reason);
        setBusy(false);
        if (!result.ok) {
            toast({ title: "Could not delete the account", description: result.error });
            return;
        }
        toast({ title: "Account deleted", description: account.email });
        onDeleted();
        onClose();
    };

    return (
        <Dialog open onOpenChange={(open) => !open && !busy && onClose()}>
            <DialogContent className="max-w-md">
                <DialogHeader>
                    <DialogTitle>Delete {account.email}</DialogTitle>
                    <DialogDescription>
                        They cannot sign in again. Toys bound to this account are released.
                        Their profile, conversations, memories and characters they created
                        are removed. This cannot be undone.
                    </DialogDescription>
                </DialogHeader>
                <Textarea
                    value={reason}
                    onChange={(event) => setReason(event.target.value)}
                    placeholder="Reason (goes to the audit log)"
                    maxLength={500}
                    rows={3}
                    autoFocus
                />
                <DialogFooter className="gap-2">
                    <Button type="button" variant="outline" className="rounded-full" onClick={onClose} disabled={busy}>
                        Cancel
                    </Button>
                    <Button
                        type="button"
                        variant="destructive"
                        className="rounded-full"
                        onClick={submit}
                        disabled={busy || reason.trim() === ""}
                    >
                        {busy ? "Deleting..." : "Delete"}
                    </Button>
                </DialogFooter>
            </DialogContent>
        </Dialog>
    );
}

export default AccountsTab;
