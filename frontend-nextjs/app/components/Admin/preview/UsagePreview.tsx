import React from "react";
import { Divider, Facts, FakeButton, Kpi, KpiRow, Note, Panel, Pill, SimpleTable, TwoColumns } from "./PreviewKit";
import { CostChart } from "./PreviewCharts";
import { PREVIEW_DEVICES } from "./previewData";

// Mean month-to-date cost of the bound toys in the example.
const AVERAGE = 4.1;

const UsagePreview: React.FC = () => {
    const rows = PREVIEW_DEVICES.filter((entry) => entry.owner).sort((a, b) => b.monthCost - a.monthCost);

    return (
        <>
            <KpiRow>
                <Kpi tone="warn" value="HK$68" label="This month so far" />
                <Kpi value="HK$27" label="Per toy per month, at today's HK$0.89" />
                <Kpi value="HK$0.045" label="Per turn" />
                <Kpi value="2,310" label="Speech minutes (STT + TTS)" />
            </KpiRow>

            <Panel title="Daily cost" hint="HK$, last 14 days, by provider">
                <CostChart />
            </Panel>

            <TwoColumns>
                <Panel title="By toy" hint="this month, most expensive first" action={<FakeButton>Export CSV</FakeButton>}>
                    <SimpleTable
                        head={[
                            { label: "Toy" },
                            { label: "Turns today", align: "right" },
                            { label: "This month", align: "right" },
                            { label: "vs average", align: "right" },
                            { label: "Daily limit" },
                        ]}
                    >
                        {rows.map((entry) => {
                            const ratio = entry.monthCost / AVERAGE;
                            return (
                                <tr key={entry.name}>
                                    <td>
                                        {entry.name}
                                        {entry.heavyUse && <span className="ml-1.5"><Pill tone="warn" dot={false}>unusual</Pill></span>}
                                    </td>
                                    <td className="text-right">{entry.turnsToday}</td>
                                    <td className="text-right">HK${entry.monthCost.toFixed(1)}</td>
                                    <td className={ratio > 2 ? "text-right font-medium text-amber-600" : "text-right"}>
                                        {ratio.toFixed(1)}×
                                    </td>
                                    <td>{entry.heavyUse ? <span className="text-gray-400">not set</span> : "45 min"}</td>
                                </tr>
                            );
                        })}
                    </SimpleTable>
                </Panel>
                <Panel title="Unusual use">
                    <Facts
                        rows={[
                            ["Alert", "Turns in a day exceed 5× the average across all toys"],
                            ["Throttle", "Over 300 turns in a day: at most 2 turns a minute for the rest of it (P2-05)"],
                            ["Refuse", "No session for an unbound or unknown MAC"],
                        ]}
                    />
                    <Divider />
                    <Note>
                        Cost comes from each turn&apos;s turn_metrics row: STT seconds, LLM tokens and TTS
                        characters, each times its unit price. Unit prices are set with the model.
                    </Note>
                </Panel>
            </TwoColumns>
        </>
    );
};

export default UsagePreview;
