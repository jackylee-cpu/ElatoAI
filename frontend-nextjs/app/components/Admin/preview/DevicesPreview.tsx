"use client";

import React, { useState } from "react";
import { Divider, Events, Facts, FakeButton, Note, Panel, Pill, SimpleTable, TwoColumns } from "./PreviewKit";
import { DEVICE_STATES, PREVIEW_DEVICES, PreviewDevice } from "./previewData";
import { cn } from "@/lib/utils";

export function DeviceStatePill({ device }: { device: PreviewDevice }) {
    const [tone, label] = DEVICE_STATES[device.state];
    return <Pill tone={tone}>{label}</Pill>;
}

const DevicesPreview: React.FC = () => {
    const [selected, setSelected] = useState("AIBuddy-2B84");
    const device = PREVIEW_DEVICES.find((entry) => entry.name === selected) ?? PREVIEW_DEVICES[0];

    return (
        <TwoColumns>
            <Panel>
                <div className="mb-3 flex flex-wrap gap-2">
                    <div className="min-w-0 flex-1 basis-60 rounded-full border border-gray-200 bg-gray-50 px-4 py-1.5 text-sm text-gray-400">
                        MAC, toy name or parent email
                    </div>
                    <div className="rounded-full border border-gray-200 bg-gray-50 px-3 py-1.5 text-sm text-gray-600">All states ▾</div>
                    <div className="rounded-full border border-gray-200 bg-gray-50 px-3 py-1.5 text-sm text-gray-600">All firmware ▾</div>
                </div>
                <SimpleTable
                    head={[
                        { label: "State" },
                        { label: "Toy" },
                        { label: "Plush (locked)" },
                        { label: "Firmware" },
                        { label: "Last seen" },
                        { label: "Wi-Fi", align: "right" },
                        { label: "Account" },
                    ]}
                >
                    {PREVIEW_DEVICES.map((entry) => (
                        <tr
                            key={entry.name}
                            onClick={() => setSelected(entry.name)}
                            className={cn(
                                "cursor-pointer",
                                entry.name === device.name ? "[&_td]:bg-sky-50" : "hover:[&_td]:bg-gray-50"
                            )}
                        >
                            <td><DeviceStatePill device={entry} /></td>
                            <td className="font-medium">
                                {entry.name}
                                {entry.heavyUse && <span className="ml-1.5"><Pill tone="warn" dot={false}>heavy use</Pill></span>}
                            </td>
                            <td>{entry.plush}</td>
                            <td className="font-mono text-xs">{entry.firmware}{entry.rollback && <span className="ml-1 text-gray-500">rolled back</span>}</td>
                            <td>{entry.lastSeen}</td>
                            <td className="text-right font-mono text-xs">{entry.rssi ? `${entry.rssi} dBm` : "—"}</td>
                            <td>{entry.owner ?? <span className="text-gray-400">—</span>}</td>
                        </tr>
                    ))}
                </SimpleTable>
                <p className="mt-2 text-xs text-gray-500">Showing 10 of 23 · click a row for details</p>
            </Panel>

            <Panel title={<span className="flex items-center gap-2">{device.name} <DeviceStatePill device={device} /></span>}>
                <Facts
                    rows={[
                        ["MAC", <span key="mac" className="font-mono text-xs">{device.mac}</span>],
                        ["Board", "Spotpear AI Toy · ESP32-C3"],
                        ["Plush", <>{device.plush} <span className="text-gray-500">locked at the factory (R-38)</span></>],
                        ["Firmware", <>{device.firmware}{device.rollback && <span className="ml-1.5"><Pill tone="bad" dot={false}>{device.rollback} rolled back</Pill></span>}</>],
                        ["Bound", device.owner ? `${device.owner} · ${device.boundOn}` : "Not bound"],
                        ["Device key", `registered ${device.keyRegistered} · token expires ${device.tokenExpires}`],
                        ["Saved Wi-Fi", device.wifi.length ? device.wifi.join(", ") : "—"],
                        ["Use", `${device.turnsToday} turns today · HK$${device.monthCost.toFixed(1)} this month`],
                    ]}
                />
                {device.rollback && (
                    <>
                        <Divider />
                        <Events
                            rows={[
                                ["today 11:40", "No server auth within 120 s of booting 1.0.1; rolled back to 1.0.0"],
                                ["today 11:37", "mbedtls_ssl_setup failed: 65 KB free, largest block 28 KB"],
                                ["today 11:36", "Downloaded 1.0.1 (1.66 MB) and restarted"],
                            ]}
                        />
                    </>
                )}
                <Divider />
                <div className="flex flex-wrap gap-2">
                    <FakeButton variant="primary">Push OTA again</FakeButton>
                    <FakeButton>Resend settings</FakeButton>
                    <FakeButton>Reset device key</FakeButton>
                    <FakeButton variant="danger">Force unbind</FakeButton>
                </div>
                <div className="mt-3">
                    <Note>
                        Conversations, memories and the child&apos;s details are never shown here (Q7). Every
                        action asks for a reason and goes to the audit log.
                    </Note>
                </div>
            </Panel>
        </TwoColumns>
    );
};

export default DevicesPreview;
