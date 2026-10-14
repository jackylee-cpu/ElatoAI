"use client";

import React, { useState } from "react";
import { Divider, Facts, Note, Panel, SimpleTable, TwoColumns } from "./PreviewKit";
import { PREVIEW_AUDIT } from "./previewData";
import { cn } from "@/lib/utils";

const AuditPreview: React.FC = () => {
    const [selected, setSelected] = useState(0);
    const entry = PREVIEW_AUDIT[selected];

    return (
        <TwoColumns>
            <Panel>
                <div className="mb-3 flex flex-wrap gap-2">
                    <div className="rounded-full border border-gray-200 bg-gray-50 px-3 py-1.5 text-sm text-gray-600">All admins ▾</div>
                    <div className="rounded-full border border-gray-200 bg-gray-50 px-3 py-1.5 text-sm text-gray-600">All actions ▾</div>
                    <div className="min-w-0 flex-1 basis-48 rounded-full border border-gray-200 bg-gray-50 px-4 py-1.5 text-sm text-gray-400">
                        MAC, character or account
                    </div>
                </div>
                <SimpleTable head={[{ label: "When" }, { label: "Admin" }, { label: "Action" }, { label: "Target" }, { label: "Reason" }]}>
                    {PREVIEW_AUDIT.map((row, index) => (
                        <tr
                            key={index}
                            onClick={() => setSelected(index)}
                            className={cn("cursor-pointer", index === selected ? "[&_td]:bg-sky-50" : "hover:[&_td]:bg-gray-50")}
                        >
                            <td>{row.at}</td>
                            <td>{row.who}</td>
                            <td>{row.action}</td>
                            <td>{row.target}</td>
                            <td className="min-w-[160px] !whitespace-normal text-gray-500">{row.reason}</td>
                        </tr>
                    ))}
                </SimpleTable>
            </Panel>
            <Panel title={entry.action} hint={`${entry.at} · ${entry.who}`}>
                <Facts rows={[["Target", entry.target], ["Reason", entry.reason]]} />
                <Divider />
                <div className="overflow-hidden rounded-xl border border-gray-100 font-mono text-xs">
                    {entry.diff.map(([sign, text], index) => (
                        <div
                            key={index}
                            className={cn(
                                "whitespace-pre-wrap break-words px-3 py-1.5",
                                sign === "-" ? "bg-rose-50 text-rose-700" : "bg-emerald-50 text-emerald-700"
                            )}
                        >
                            {sign} {text}
                        </div>
                    ))}
                </div>
                <div className="mt-3">
                    <Note>Only settings and actions are recorded, never a conversation or a memory (Q7).</Note>
                </div>
            </Panel>
        </TwoColumns>
    );
};

export default AuditPreview;
