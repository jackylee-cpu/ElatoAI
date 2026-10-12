"use client";

import React, { useMemo, useState } from "react";
import { Copy, RefreshCw } from "lucide-react";
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
import { createAccountAction } from "@/app/admin/actions";
import { MIN_PASSWORD_LENGTH } from "@/lib/passwords";

type RoleChoice = "none" | AdminRole;

interface AccountsTabProps {
    accounts: IAccountEntry[];
}

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

/**
 * Create login accounts and see who has one. Super admins only -- the page
 * does not render this tab for anyone else, and the action checks again.
 */
const AccountsTab: React.FC<AccountsTabProps> = ({ accounts }) => {
    const [email, setEmail] = useState("");
    const [password, setPassword] = useState(generatePassword);
    const [role, setRole] = useState<RoleChoice>("none");
    const [busy, setBusy] = useState(false);
    // Shown once after creating, so the admin can pass the login on. Not kept
    // anywhere else: it is gone on reload.
    const [created, setCreated] = useState<{ email: string; password: string } | null>(null);
    const [filter, setFilter] = useState("");

    const shown = useMemo(() => {
        const needle = filter.trim().toLowerCase();
        return needle ? accounts.filter((a) => a.email.includes(needle)) : accounts;
    }, [accounts, filter]);

    const onCreate = async (event: React.FormEvent) => {
        event.preventDefault();
        setBusy(true);
        const result = await createAccountAction(
            email,
            password,
            role === "none" ? null : role,
        );
        setBusy(false);
        if (!result.ok) {
            toast({ title: "Could not create the account", description: result.error });
            return;
        }
        setCreated({ email: email.trim().toLowerCase(), password });
        setEmail("");
        setPassword(generatePassword());
        setRole("none");
        if (result.roleError) {
            toast({ title: "Account created", description: result.roleError });
        } else {
            toast({ title: "Account created" });
        }
    };

    const copyLogin = async () => {
        if (!created) return;
        try {
            await navigator.clipboard.writeText(
                `Email: ${created.email}\nPassword: ${created.password}`,
            );
            toast({ title: "Copied" });
        } catch {
            toast({ title: "Could not copy -- select the text instead" });
        }
    };

    return (
        <div className="flex flex-col gap-4">
            <Card className="rounded-2xl border-0 bg-white/80 shadow-sm">
                <CardHeader className="pb-2">
                    <CardTitle className="text-base">Create an account</CardTitle>
                    <CardDescription>
                        The account can log in straight away -- no
                        confirmation email is sent. Give the person the email
                        and password yourself; they can change the password
                        later with &quot;Forgot password&quot;.
                    </CardDescription>
                </CardHeader>
                <CardContent className="flex flex-col gap-3">
                    <form onSubmit={onCreate} className="flex flex-row flex-wrap items-center gap-2">
                        <Input
                            type="email"
                            placeholder="someone@example.com"
                            value={email}
                            onChange={(event) => setEmail(event.target.value)}
                            className="max-w-xs"
                            autoComplete="off"
                            required
                        />
                        <div className="flex flex-row items-center gap-1">
                            <Input
                                type="text"
                                aria-label="Password"
                                value={password}
                                onChange={(event) => setPassword(event.target.value)}
                                className="w-[170px] font-mono"
                                minLength={MIN_PASSWORD_LENGTH}
                                autoComplete="off"
                                required
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
                        <Select value={role} onValueChange={(value) => setRole(value as RoleChoice)}>
                            <SelectTrigger className="w-[170px]">
                                <SelectValue />
                            </SelectTrigger>
                            <SelectContent>
                                <SelectItem value="none">No admin role</SelectItem>
                                <SelectItem value="content_admin">Content admin</SelectItem>
                                <SelectItem value="super_admin">Super admin</SelectItem>
                            </SelectContent>
                        </Select>
                        <Button type="submit" disabled={busy}>
                            {busy ? "Creating..." : "Create"}
                        </Button>
                    </form>

                    {created && (
                        <div className="flex flex-row flex-wrap items-center justify-between gap-2 rounded-xl border border-green-200 bg-green-50 px-3 py-2 text-sm">
                            <span className="font-mono">
                                {created.email} / {created.password}
                            </span>
                            <div className="flex flex-row gap-1">
                                <Button type="button" variant="ghost" size="sm" onClick={copyLogin}>
                                    <Copy className="mr-1 h-3.5 w-3.5" /> Copy
                                </Button>
                                <Button
                                    type="button"
                                    variant="ghost"
                                    size="sm"
                                    onClick={() => setCreated(null)}
                                >
                                    Hide
                                </Button>
                            </div>
                        </div>
                    )}
                </CardContent>
            </Card>

            <Card className="rounded-2xl border-0 bg-white/80 shadow-sm">
                <CardHeader className="flex flex-row flex-wrap items-center justify-between gap-2 pb-2">
                    <CardTitle className="text-base">
                        Accounts{" "}
                        <span className="text-sm font-normal text-muted-foreground">
                            ({accounts.length})
                        </span>
                    </CardTitle>
                    <Input
                        type="search"
                        placeholder="Filter by email"
                        value={filter}
                        onChange={(event) => setFilter(event.target.value)}
                        className="h-9 max-w-[220px]"
                    />
                </CardHeader>
                <CardContent>
                    <Table>
                        <TableHeader>
                            <TableRow>
                                <TableHead>Email</TableHead>
                                <TableHead>Created</TableHead>
                                <TableHead>Last log in</TableHead>
                                <TableHead>Status</TableHead>
                            </TableRow>
                        </TableHeader>
                        <TableBody>
                            {shown.map((account) => (
                                <TableRow key={account.user_id}>
                                    <TableCell className="text-sm">{account.email}</TableCell>
                                    <TableCell className="whitespace-nowrap text-xs text-muted-foreground">
                                        {formatDate(account.created_at)}
                                    </TableCell>
                                    <TableCell className="whitespace-nowrap text-xs text-muted-foreground">
                                        {formatDate(account.last_sign_in_at)}
                                    </TableCell>
                                    <TableCell>
                                        {account.confirmed ? (
                                            <Badge variant="outline">Active</Badge>
                                        ) : (
                                            <Badge variant="secondary">Email not confirmed</Badge>
                                        )}
                                    </TableCell>
                                </TableRow>
                            ))}
                            {shown.length === 0 && (
                                <TableRow>
                                    <TableCell colSpan={4} className="text-center text-sm text-muted-foreground">
                                        No accounts match.
                                    </TableCell>
                                </TableRow>
                            )}
                        </TableBody>
                    </Table>
                </CardContent>
            </Card>
        </div>
    );
};

export default AccountsTab;
