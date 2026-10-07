"use client";

import React, { useState } from "react";
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
import { grantAdminRoleAction, revokeAdminRoleAction } from "@/app/admin/actions";

const ROLE_LABELS: Record<AdminRole, string> = {
    super_admin: "Super admin",
    content_admin: "Content admin",
};

interface AdminsTabProps {
    admins: IAdminRoleEntry[];
    currentUserId: string;
}

/**
 * Who holds which admin role. Super admins only -- the page does not render
 * this tab for anyone else, and admin_list_roles() refuses them anyway.
 */
const AdminsTab: React.FC<AdminsTabProps> = ({ admins, currentUserId }) => {
    const [email, setEmail] = useState("");
    const [role, setRole] = useState<AdminRole>("content_admin");
    const [busy, setBusy] = useState<string | null>(null);

    const onGrant = async (event: React.FormEvent) => {
        event.preventDefault();
        setBusy("grant");
        const result = await grantAdminRoleAction(email, role);
        setBusy(null);
        if (result.ok) {
            setEmail("");
            toast({ title: `${ROLE_LABELS[role]} granted` });
        } else {
            toast({ title: "Could not grant it", description: result.error });
        }
    };

    const onRevoke = async (entry: IAdminRoleEntry) => {
        const key = `${entry.user_id}:${entry.role}`;
        setBusy(key);
        const result = await revokeAdminRoleAction(entry.user_id, entry.role);
        setBusy(null);
        if (!result.ok) {
            toast({ title: "Could not revoke it", description: result.error });
        }
    };

    return (
        <div className="flex flex-col gap-4">
            <Card className="rounded-2xl border-0 bg-white/80 shadow-sm">
                <CardHeader className="pb-2">
                    <CardTitle className="text-base">Grant a role</CardTitle>
                    <CardDescription>
                        The account must already exist. It sets up an
                        authenticator app the first time it opens Admin, and
                        cannot get in without one. Content admins edit
                        characters and IPs; super admins also change the model
                        and this list. No role can read children&apos;s
                        conversations or memories.
                    </CardDescription>
                </CardHeader>
                <CardContent>
                    <form onSubmit={onGrant} className="flex flex-row flex-wrap gap-2 items-center">
                        <Input
                            type="email"
                            placeholder="someone@example.com"
                            value={email}
                            onChange={(event) => setEmail(event.target.value)}
                            className="max-w-sm"
                            required
                        />
                        <Select value={role} onValueChange={(value) => setRole(value as AdminRole)}>
                            <SelectTrigger className="w-[180px]">
                                <SelectValue />
                            </SelectTrigger>
                            <SelectContent>
                                <SelectItem value="content_admin">Content admin</SelectItem>
                                <SelectItem value="super_admin">Super admin</SelectItem>
                            </SelectContent>
                        </Select>
                        <Button type="submit" disabled={busy === "grant"}>
                            Grant
                        </Button>
                    </form>
                </CardContent>
            </Card>

            <Card className="rounded-2xl border-0 bg-white/80 shadow-sm">
                <CardHeader className="pb-2">
                    <CardTitle className="text-base">Admins</CardTitle>
                </CardHeader>
                <CardContent>
                    <Table>
                        <TableHeader>
                            <TableRow>
                                <TableHead>Email</TableHead>
                                <TableHead>Role</TableHead>
                                <TableHead>Authenticator</TableHead>
                                <TableHead>Granted</TableHead>
                                <TableHead className="w-[100px]" />
                            </TableRow>
                        </TableHeader>
                        <TableBody>
                            {admins.map((entry) => {
                                const key = `${entry.user_id}:${entry.role}`;
                                const isSelf =
                                    entry.user_id === currentUserId &&
                                    entry.role === "super_admin";
                                return (
                                    <TableRow key={key}>
                                        <TableCell className="text-sm">{entry.email}</TableCell>
                                        <TableCell>
                                            <Badge variant="outline">
                                                {ROLE_LABELS[entry.role] ?? entry.role}
                                            </Badge>
                                        </TableCell>
                                        <TableCell className="text-xs">
                                            {entry.has_totp ? (
                                                "set up"
                                            ) : (
                                                <span className="text-muted-foreground">
                                                    not yet
                                                </span>
                                            )}
                                        </TableCell>
                                        <TableCell className="text-xs text-muted-foreground whitespace-nowrap">
                                            {new Date(entry.granted_at).toLocaleDateString()}
                                            {entry.granted_by_email
                                                ? ` by ${entry.granted_by_email}`
                                                : ""}
                                        </TableCell>
                                        <TableCell className="text-right">
                                            {!isSelf && (
                                                <Button
                                                    variant="ghost"
                                                    size="sm"
                                                    disabled={busy === key}
                                                    onClick={() => onRevoke(entry)}
                                                >
                                                    Revoke
                                                </Button>
                                            )}
                                        </TableCell>
                                    </TableRow>
                                );
                            })}
                        </TableBody>
                    </Table>
                </CardContent>
            </Card>
        </div>
    );
};

export default AdminsTab;
