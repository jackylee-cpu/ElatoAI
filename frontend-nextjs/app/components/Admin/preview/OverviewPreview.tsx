import React from "react";
import { Facts, Kpi, KpiRow, Meter, Panel, Pill, SimpleTable, TwoColumns, Events } from "./PreviewKit";
import { ActivityChart } from "./PreviewCharts";
import { PREVIEW_AUDIT } from "./previewData";
import type { AdminPageId } from "../adminPages";

const ALERTS: {
    tone: "bad" | "warn";
    tag: string;
    text: string;
    detail: string;
    link: string;
    page: AdminPageId;
}[] = [
    {
        tone: "bad",
        tag: "OTA failed",
        text: "AIBuddy-2B84 did not pass probation and rolled back to 1.0.0",
        detail: "No server auth within 120 s · mbedtls_ssl_setup failed",
        link: "Open device",
        page: "devices",
    },
    {
        tone: "warn",
        tag: "Heavy use",
        text: "AIBuddy-6364 has had 186 turns today, 9× the average",
        detail: "The parent has not set a daily limit",
        link: "Open usage",
        page: "usage",
    },
    {
        tone: "warn",
        tag: "Provider",
        text: "OpenRouter · DeepSeek v4 flash: 4.2% errors in the last hour",
        detail: "allow_fallbacks is off, so errors reach the toys",
        link: "System health",
        page: "health",
    },
];

const OverviewPreview: React.FC<{ onOpen: (id: AdminPageId) => void }> = ({ onOpen }) => (
    <>
        <KpiRow>
            <Kpi tone="ok" value="14" unit="/ 23" label="Toys online / bound" />
            <Kpi value="412" label="Turns today · +13% on yesterday" />
            <Kpi tone="warn" value="HK$18.6" label="Cost today · HK$0.89 a toy" />
            <Kpi tone="bad" value="3" label="Need attention" />
        </KpiRow>

        <TwoColumns>
            <Panel title="Active toys and turns" hint="last 14 days">
                <ActivityChart />
            </Panel>
            <Panel title="Firmware" hint="spotpear-c3">
                <Meter
                    parts={[
                        { percent: 17.4, className: "bg-emerald-500" },
                        { percent: 78.3, className: "bg-[#2a78cf]" },
                        { percent: 4.3, className: "bg-rose-500" },
                    ]}
                />
                <div className="mt-3">
                    <SimpleTable head={[{ label: "Version" }, { label: "Toys", align: "right" }]}>
                        <tr><td>1.0.2 <span className="text-gray-500">rolling out</span></td><td className="text-right">4</td></tr>
                        <tr><td>1.0.1 <span className="text-gray-500">current</span></td><td className="text-right">18</td></tr>
                        <tr><td>Rolled back to 1.0.0</td><td className="text-right">1</td></tr>
                    </SimpleTable>
                </div>
                <div className="my-3 h-px bg-gray-100" />
                <h4 className="mb-2 text-sm font-semibold text-gray-900">Plush</h4>
                <Facts rows={[["波波熊", "9 toys"], ["嘟嘟龍", "7 toys"], ["叮叮兔", "3 toys"], ["咪咪貓", "2 toys"], ["跳跳蛙", "2 toys"]]} />
            </Panel>
        </TwoColumns>

        <TwoColumns>
            <Panel title="Needs attention">
                <div className="flex flex-col gap-2">
                    {ALERTS.map((alert) => (
                        <div
                            key={alert.tag}
                            className="grid grid-cols-[auto_minmax(0,1fr)] items-center gap-3 rounded-2xl bg-sky-50/60 px-3 py-2.5 sm:grid-cols-[auto_minmax(0,1fr)_auto]"
                        >
                            <Pill tone={alert.tone}>{alert.tag}</Pill>
                            <div className="text-[13px] text-gray-900">
                                {alert.text}
                                <span className="block text-xs text-gray-500">{alert.detail}</span>
                            </div>
                            <button
                                type="button"
                                onClick={() => onOpen(alert.page)}
                                className="col-start-2 justify-self-start whitespace-nowrap text-[13px] font-medium text-[#2a78cf] hover:underline sm:col-start-auto"
                            >
                                {alert.link} →
                            </button>
                        </div>
                    ))}
                </div>
            </Panel>
            <Panel title="Recent admin actions">
                <Events rows={PREVIEW_AUDIT.slice(0, 4).map((entry) => [entry.at, `${entry.who} · ${entry.action} · ${entry.target}`])} />
                <button
                    type="button"
                    onClick={() => onOpen("audit")}
                    className="mt-2 text-[13px] font-medium text-[#2a78cf] hover:underline"
                >
                    Full audit log →
                </button>
            </Panel>
        </TwoColumns>
    </>
);

export default OverviewPreview;
