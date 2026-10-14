import React from "react";
import { Divider, Events, Facts, FakeButton, Note, Panel, SimpleTable, TwoColumns } from "./PreviewKit";
import { PREVIEW_ACCOUNT, PREVIEW_DEVICES } from "./previewData";
import { DeviceStatePill } from "./DevicesPreview";

const SupportPreview: React.FC = () => {
    const account = PREVIEW_ACCOUNT;
    const devices = PREVIEW_DEVICES.filter((entry) => account.devices.includes(entry.name));

    return (
        <>
            <Panel>
                <div className="rounded-full border border-gray-200 bg-gray-50 px-4 py-2 text-sm text-gray-900">
                    kelly
                    <span className="ml-3 text-gray-400">parent email, last four of a toy&apos;s name, or MAC</span>
                </div>
            </Panel>
            <TwoColumns>
                <Panel title={account.email}>
                    <Facts
                        rows={[
                            ["Joined", account.joined],
                            ["Signs in with", account.login],
                            ["Parent PIN", account.pin],
                            ["Daily limit", account.dailyLimit],
                            ["Quiet hours", account.quietHours],
                        ]}
                    />
                    <Divider />
                    <h4 className="mb-1 text-sm font-semibold text-gray-900">
                        Toys <span className="font-normal text-gray-500">{devices.length}</span>
                    </h4>
                    <SimpleTable head={[{ label: "State" }, { label: "Toy" }, { label: "Plush" }, { label: "Firmware" }, { label: "Last seen" }]}>
                        {devices.map((entry) => (
                            <tr key={entry.name}>
                                <td><DeviceStatePill device={entry} /></td>
                                <td>{entry.name}</td>
                                <td>{entry.plush}</td>
                                <td className="font-mono text-xs">{entry.firmware}</td>
                                <td>{entry.lastSeen}</td>
                            </tr>
                        ))}
                    </SimpleTable>
                </Panel>
                <Panel title="Recent events" hint="system events only">
                    <Events rows={account.events} />
                    <Divider />
                    <h4 className="mb-2 text-sm font-semibold text-gray-900">Support actions</h4>
                    <div className="flex flex-wrap gap-2">
                        <FakeButton>Unbind 2B84</FakeButton>
                        <FakeButton>Replace toy</FakeButton>
                        <FakeButton>Resend sign-in code</FakeButton>
                        <FakeButton variant="danger">Delete account and data</FakeButton>
                    </div>
                    <div className="mt-3">
                        <Note>
                            Replace toy unbinds the old one, binds the new one and moves the memories across
                            (waits on P1-12). Deleting an account also deletes its conversations, memories and
                            bindings, and cannot be undone.
                        </Note>
                    </div>
                </Panel>
            </TwoColumns>
        </>
    );
};

export default SupportPreview;
