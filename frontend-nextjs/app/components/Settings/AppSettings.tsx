"use client";

import {
    claimDeviceAction,
    connectUserToDevice,
    listUnclaimedDevices,
    signOutAction,
    unbindDeviceAction,
} from "@/app/actions";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { Input } from "@/components/ui/input";
import { LogOut } from "lucide-react";

import GeneralUserForm from "./UserForm";
import { Slider } from "@/components/ui/slider";
import { updateUser } from "@/db/users";
import _ from "lodash";
import { createClient } from "@/utils/supabase/client";
import React, { useCallback } from "react";
import { getUserDevices, updateDevice } from "@/db/devices";
import { useToast } from "@/components/ui/use-toast";

interface AppSettingsProps {
    selectedUser: IUser;
    heading?: React.ReactNode;
    hideUserForm?: boolean;
}

const skipDeviceRegistration = process.env.NEXT_PUBLIC_SKIP_DEVICE_REGISTRATION === "True";

type BoundDevice = Awaited<ReturnType<typeof getUserDevices>>[number];

/** One device on the account: its own volume, and a way to let it go. */
const BoundDeviceRow: React.FC<{
    device: BoundDevice;
    busy: boolean;
    onUnbind: (deviceId: string) => void;
}> = ({ device, busy, onUnbind }) => {
    const supabase = createClient();
    const [volume, setVolume] = React.useState([device.volume ?? 50]);

    // One debounced writer per row, so dragging one slider never saves another
    // device's volume or a stale value.
    const saveVolume = React.useMemo(
        () => _.debounce((value: number) => {
            updateDevice(supabase, { volume: value }, device.device_id);
        }, 1000),
        [supabase, device.device_id],
    );
    React.useEffect(() => () => saveVolume.flush(), [saveVolume]);

    return (
        <div className="flex flex-col gap-3 rounded-md border border-gray-200 p-3">
            <div className="flex flex-row items-center justify-between">
                <div className="flex flex-col">
                    <span className="text-sm font-medium text-gray-800">
                        Device {device.user_code}
                    </span>
                    <span className="font-mono text-xs text-gray-400">
                        {device.mac_address}
                    </span>
                </div>
                <Button
                    size="sm"
                    variant="outline"
                    disabled={busy}
                    onClick={() => onUnbind(device.device_id)}
                >
                    Unbind
                </Button>
            </div>
            <div className="flex flex-row gap-2 items-center flex-nowrap">
                <Label className="text-xs text-gray-500 w-14">Volume</Label>
                <Slider
                    value={volume}
                    onValueChange={(value) => {
                        setVolume(value);
                        saveVolume(value[0]);
                    }}
                    className="sm:w-1/2"
                    max={100}
                    min={1}
                    step={1}
                />
                <p className="text-gray-500 text-sm">{volume}%</p>
            </div>
        </div>
    );
};


const AppSettings: React.FC<AppSettingsProps> = ({
    selectedUser,
    heading,
    hideUserForm = false,
}) => {
    const supabase = createClient();
    const { toast } = useToast();
    const [devices, setDevices] = React.useState<BoundDevice[]>([]);
    const userFormRef = React.useRef<{ submitForm: () => void } | null>(null);
    const [deviceCode, setDeviceCode] = React.useState("");
    const [error, setError] = React.useState("");
    const [unclaimed, setUnclaimed] = React.useState<
        { device_id: string; mac_address: string; user_code: string }[]
    >([]);
    const [busyDeviceId, setBusyDeviceId] = React.useState<string | null>(null);

    const handleSave = () => {
        userFormRef.current?.submitForm();
    };

    const loadDevices = useCallback(async () => {
        setDevices(await getUserDevices(supabase, selectedUser.user_id));
    }, [selectedUser.user_id, supabase]);

    React.useEffect(() => {
        loadDevices();
    }, [loadDevices]);

    // A board registers itself the moment it gets online, so poll while the user
    // is on this screen -- it should appear a few seconds after it joins their
    // WiFi, without them having to reload. An account can own any number of
    // boards, so this keeps going after the first one is claimed.
    React.useEffect(() => {
        let cancelled = false;
        const load = async () => {
            const devices = await listUnclaimedDevices();
            if (!cancelled) {
                // A server action can resolve to undefined -- in development
                // whenever the poll lands mid-rebuild -- and `.length` on that
                // took the whole settings panel down.
                setUnclaimed(Array.isArray(devices) ? devices : []);
            }
        };
        load();
        const timer = setInterval(load, 5000);
        return () => {
            cancelled = true;
            clearInterval(timer);
        };
    }, []);

    const handleClaim = async (deviceId: string) => {
        setBusyDeviceId(deviceId);
        const ok = await claimDeviceAction(deviceId);
        setBusyDeviceId(null);
        if (!ok) {
            setError("Could not claim that device - someone may have just taken it");
            return;
        }
        setError("");
        setUnclaimed((devices) => devices.filter((d) => d.device_id !== deviceId));
        loadDevices();
    };

    const handleUnbind = async (deviceId: string) => {
        setBusyDeviceId(deviceId);
        const ok = await unbindDeviceAction(deviceId);
        setBusyDeviceId(null);
        if (ok) {
            setError("");
            loadDevices();
        }
    };

    const onSave = async (values: any, userId: string) => {

        await updateUser(
            supabase,
            {
                supervisee_age: values.supervisee_age,
                supervisee_name: values.supervisee_name,
                supervisee_persona: values.supervisee_persona,
            },
            userId);
            toast({
                description: "Your prefereces have been saved!",
            });
    }

    return (
        <>
            {!hideUserForm && (
            <GeneralUserForm
                    selectedUser={selectedUser}
                    userId={selectedUser.user_id}
                    heading={heading}
                    onSave={onSave}
                    onClickCallback={() => handleSave()}
                />
            )}

            <div className={`space-y-4 max-w-screen-sm ${hideUserForm ? "mt-0" : "mt-12"}`}>
                <h2 className="text-lg font-semibold border-b border-gray-200 pb-2">
                    Device settings
                </h2>
                {skipDeviceRegistration && <div className="flex flex-col text-purple-500 text-xs gap-2">You don&apos;t need to register your device because NEXT_PUBLIC_SKIP_DEVICE_REGISTRATION is set to True.</div>}
                <div className="flex flex-col gap-6">
                <div className="flex flex-col gap-2">
                    <div className="flex flex-row items-center gap-2">
                        <Label className="text-sm font-medium text-gray-700">
                            Your devices
                        </Label>
                        <div
                            className={`rounded-full flex-shrink-0 h-2 w-2 ${
                                devices.length > 0 ? 'bg-green-500' : 'bg-amber-500'
                            }`}
                        />
                    </div>

                    {devices.length > 0 && (
                        <div className="flex flex-col gap-2 mt-2">
                            {devices.map((device) => (
                                <BoundDeviceRow
                                    key={device.device_id}
                                    device={device}
                                    busy={busyDeviceId !== null}
                                    onUnbind={handleUnbind}
                                />
                            ))}
                        </div>
                    )}

                    <Label className="text-sm font-medium text-gray-700 mt-4">
                        {devices.length > 0 ? "Add another device" : "Register your device"}
                    </Label>
                    <div className="flex flex-col gap-2">
                        {unclaimed.length === 0 ? (
                            <div className="rounded-md border border-dashed border-gray-200 p-3 text-xs text-gray-500">
                                <p className="font-medium text-gray-700">No new devices found yet.</p>
                                <p className="mt-1">
                                    Power on your device, join its
                                    {" "}<span className="font-mono">AIBuddy-XXXX</span>{" "}
                                    WiFi network (XXXX is the end of its MAC address), open
                                    {" "}<span className="font-mono">http://192.168.4.1/wifi</span>{" "}
                                    and give it your WiFi. Then come back here - it shows up
                                    within a few seconds of connecting.
                                </p>
                            </div>
                        ) : (
                            unclaimed.map((device) => (
                                <div
                                    key={device.device_id}
                                    className="flex flex-row items-center justify-between rounded-md border border-gray-200 p-3"
                                >
                                    <div className="flex flex-col">
                                        <span className="text-sm font-medium text-gray-800">
                                            Device {device.user_code}
                                        </span>
                                        <span className="font-mono text-xs text-gray-400">
                                            {device.mac_address}
                                        </span>
                                    </div>
                                    <Button
                                        size="sm"
                                        disabled={busyDeviceId === device.device_id}
                                        onClick={() => handleClaim(device.device_id)}
                                    >
                                        {busyDeviceId === device.device_id ? "Claiming..." : "Claim"}
                                    </Button>
                                </div>
                            ))
                        )}
                    </div>

                    <div className="flex flex-row items-center gap-2 mt-2">
                        <Input
                            value={deviceCode}
                            onChange={(e) =>
                                setDeviceCode(
                                    e.target.value.toUpperCase().replace(/[^A-Z2-9]/g, ""),
                                )
                            }
                            placeholder="Or enter the device code"
                            maxLength={6}
                        />
                        <Button
                            size="sm"
                            variant="outline"
                            disabled={deviceCode.length !== 6}
                            onClick={async () => {
                                const result = await connectUserToDevice(deviceCode);
                                if (!result) {
                                    setError("Error registering device");
                                } else {
                                    setError("");
                                    setDeviceCode("");
                                }
                                loadDevices();
                            }}
                        >
                            Register
                        </Button>
                    </div>
                    <p className="text-xs text-gray-400">
                        {error ? <span className="text-red-500">{error}.</span> :
                            "Enter a device code to add it to your account."}
                    </p>
                </div>
                    <div className="flex flex-col gap-2 mt-2">
                        <Label className="text-sm font-medium text-gray-700">
                            Logged in as
                        </Label>
                        <Input
                            // autoFocus
                            disabled
                            value={selectedUser?.email}
                            className="max-w-screen-sm h-10 bg-white"
                            autoComplete="on"
                            style={{
                                fontSize: 16,
                            }}
                        />
                    </div>
            <form
                            action={signOutAction}
                        className="flex flex-row justify-between mt-4"
                    >
                        <Button
                            variant="destructive_outline"
                            size="sm"
                            className="font-medium flex flex-row items-center rounded-full gap-2 "
                        >
                            <LogOut size={18} strokeWidth={2} />
                            <span>Logout</span>
                            </Button>
                        </form>
                </div>
            </div>
        </>
    );
};

export default AppSettings;