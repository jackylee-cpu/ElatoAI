import React from "react";
import { FakeButton, Note, Panel, Pill, SimpleTable } from "./PreviewKit";
import { PREVIEW_BOARDS, SELF_TEST_LABELS } from "./previewData";
import { cn } from "@/lib/utils";

const FUNNEL: { value: string; label: string; className?: string }[] = [
    { value: "300", label: "Imported" },
    { value: "212", label: "Key and host written" },
    { value: "205", label: "Self-test passed", className: "text-emerald-600" },
    { value: "7", label: "Self-test failed", className: "text-rose-600" },
    { value: "88", label: "Not started" },
];

const FactoryPreview: React.FC = () => (
    <>
        <Panel
            title="Batch SP-2026-12-C"
            hint="Spotpear · 300 boards for this deployment"
            action={
                <div className="flex flex-wrap gap-2">
                    <FakeButton>Import MAC list (CSV)</FakeButton>
                    <FakeButton>Export failures</FakeButton>
                </div>
            }
        >
            <div className="grid grid-cols-2 gap-2 sm:grid-cols-3 lg:grid-cols-5">
                {FUNNEL.map((step) => (
                    <div key={step.label} className="rounded-2xl bg-sky-50/60 px-3 py-2.5">
                        <div className={cn("font-fredoka text-2xl font-semibold tabular-nums text-gray-900", step.className)}>
                            {step.value}
                        </div>
                        <div className="text-xs text-gray-500">{step.label}</div>
                    </div>
                ))}
            </div>
        </Panel>

        <Panel title="Boards" hint="tick boards without a key yet to assign their plush in one go">
            <div className="mb-3 flex flex-wrap items-center gap-2 text-sm text-gray-500">
                0 selected →
                <span className="rounded-full border border-gray-200 bg-gray-50 px-3 py-1.5 text-gray-700">波波熊 ▾</span>
                <FakeButton variant="primary">Apply</FakeButton>
            </div>
            <SimpleTable
                head={[
                    { label: "" },
                    { label: "MAC" },
                    { label: "Plush" },
                    { label: "Key" },
                    { label: "Self-test" },
                    { label: "Station" },
                    { label: "Time" },
                ]}
            >
                {PREVIEW_BOARDS.map((board) => (
                    <tr key={board.mac}>
                        <td>
                            {board.keyWritten ? (
                                <span title="Key written; plush locked" aria-label="Locked">🔒</span>
                            ) : (
                                <input type="checkbox" disabled aria-label={`Select ${board.mac}`} />
                            )}
                        </td>
                        <td className="font-mono text-xs">{board.mac}</td>
                        <td>{board.plush ?? <span className="text-gray-400">not set</span>}</td>
                        <td>{board.keyWritten ? <Pill tone="ok">Written</Pill> : <Pill>Not yet</Pill>}</td>
                        <td>
                            <span className="inline-flex gap-1">
                                {SELF_TEST_LABELS.map((label, index) => (
                                    <span
                                        key={label}
                                        className={cn(
                                            "rounded px-1 py-0.5 text-[10px] font-medium",
                                            board.selfTest === null && "bg-gray-100 text-gray-400",
                                            board.selfTest?.[index] === true && "bg-emerald-50 text-emerald-700",
                                            board.selfTest?.[index] === false && "bg-rose-50 text-rose-700"
                                        )}
                                    >
                                        {label}
                                    </span>
                                ))}
                            </span>
                            {board.failure && <span className="ml-2 text-xs text-rose-600">{board.failure}</span>}
                        </td>
                        <td>{board.station}</td>
                        <td>{board.at}</td>
                    </tr>
                ))}
            </SimpleTable>
            <div className="mt-3">
                <Note>
                    The station script writes the device key, the brand&apos;s server and the plush over
                    serial (R-10, R-35, Q10). After that the plush is locked: only a super admin can change it
                    here, never a parent (R-38). This deployment only sees the boards assigned to it.
                </Note>
            </div>
        </Panel>
    </>
);

export default FactoryPreview;
