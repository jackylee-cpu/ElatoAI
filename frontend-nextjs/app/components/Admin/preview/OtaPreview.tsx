import React from "react";
import { Divider, Facts, FakeButton, Meter, Note, Panel, Pill, SimpleTable, TwoColumns } from "./PreviewKit";
import { PREVIEW_RELEASES, ROLLOUT_STAGES } from "./previewData";
import { cn } from "@/lib/utils";

// The rollout of 1.0.2 is at its second stage in the example.
const STAGE = 1;

const OtaPreview: React.FC = () => (
    <>
        <Panel
            title="Releases"
            hint="spotpear-c3 (Spotpear AI Toy)"
            action={<FakeButton variant="primary">+ Upload build</FakeButton>}
        >
            <SimpleTable
                head={[
                    { label: "Version" },
                    { label: "State" },
                    { label: "Updated", align: "right" },
                    { label: "Rolled back", align: "right" },
                    { label: "Size", align: "right" },
                    { label: "Published" },
                    { label: "Notes" },
                ]}
            >
                {PREVIEW_RELEASES.map((release) => (
                    <tr key={release.version}>
                        <td className="font-mono text-xs font-medium">{release.version}</td>
                        <td>
                            {release.state === "rolling" && <Pill tone="info">Rolling out · {ROLLOUT_STAGES[STAGE][0]}</Pill>}
                            {release.state === "current" && <Pill tone="ok">Current</Pill>}
                            {release.state === "old" && <Pill>Old</Pill>}
                        </td>
                        <td className="text-right">{release.updated === null ? "—" : `${release.updated} / ${release.targeted}`}</td>
                        <td className={cn("text-right", release.rolledBack ? "font-medium text-rose-600" : "")}>
                            {release.rolledBack ?? "—"}
                        </td>
                        <td className="text-right font-mono text-xs">{release.sizeMb.toFixed(2)} MB</td>
                        <td>{release.publishedAt}</td>
                        <td className="min-w-[240px] !whitespace-normal text-gray-500">{release.notes}</td>
                    </tr>
                ))}
            </SimpleTable>
        </Panel>

        <TwoColumns>
            <Panel title="Rolling out 1.0.2">
                <div className="mb-3 grid grid-cols-2 gap-1.5 sm:grid-cols-4">
                    {ROLLOUT_STAGES.map(([name, scope], index) => (
                        <div
                            key={name}
                            className={cn(
                                "rounded-xl px-3 py-2 text-xs",
                                index < STAGE && "bg-emerald-50 text-emerald-700",
                                index === STAGE && "bg-sky-50 text-[#2a78cf] ring-1 ring-[#2a78cf]",
                                index > STAGE && "bg-gray-50 text-gray-500"
                            )}
                        >
                            <div className="text-sm font-medium text-gray-900">{name}</div>
                            {scope}
                        </div>
                    ))}
                </div>
                <Facts
                    rows={[
                        ["Auto-pause", "More than 5% roll back, or any toy restarts 3 times during probation"],
                        ["Probation", "120 s after the server accepts the toy; a failure there goes back to the previous build"],
                    ]}
                />
                <Divider />
                <div className="flex flex-wrap gap-2">
                    <FakeButton>Pause</FakeButton>
                    <FakeButton variant="primary">Widen to {ROLLOUT_STAGES[STAGE + 1][0]}</FakeButton>
                    <FakeButton>Make current</FakeButton>
                </div>
            </Panel>
            <Panel title="App partition">
                <Meter parts={[{ percent: 85.5, className: "bg-amber-500" }]} />
                <p className="mt-2 text-sm text-gray-900">
                    <span className="font-medium">1.71 MB of 2.00 MB</span> · 85.5%{" "}
                    <span className="text-gray-500">(1.0.1 was 83%)</span>
                </p>
                <div className="mt-2">
                    <Note>
                        OTA cannot change the partition table. Enlarge the app partition before the
                        production flash (P2-12), or toys already shipped can never update past 2 MB.
                    </Note>
                </div>
                <Divider />
                <h4 className="mb-1 text-sm font-semibold text-gray-900">Rolled back</h4>
                <SimpleTable head={[{ label: "Toy" }, { label: "From → to" }, { label: "Why" }]}>
                    <tr>
                        <td>AIBuddy-2B84</td>
                        <td className="font-mono text-xs">1.0.1 → 1.0.0</td>
                        <td className="text-gray-500">TLS handshake failed</td>
                    </tr>
                </SimpleTable>
            </Panel>
        </TwoColumns>
    </>
);

export default OtaPreview;
