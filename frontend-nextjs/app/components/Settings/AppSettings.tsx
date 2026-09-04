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
import { doesUserHaveADevice, updateDevice } from "@/db/devices";
import { useToast } from "@/components/ui/use-toast";

interface AppSettingsProps {
    selectedUser: IUser;
    heading: React.ReactNode;
}

const skipDeviceRegistration = process.env.NEXT_PUBLIC_SKIP_DEVICE_REGISTRATION === "True";


const AppSettings: React.FC<AppSettingsProps> = ({
    selectedUser,
    heading,
}) => {
    const supabase = createClient();
    const { toast } = useToast();
    const [isConnected, setIsConnected] = React.useState(false);
    const doctorFormRef = React.useRef<{ submitForm: () => void } | null>(null);
    const userFormRef = React.useRef<{ submitForm: () => void } | null>(null);
    const [deviceCode, setDeviceCode] = React.useState("");
    const [error, setError] = React.useState("");
    const [unclaimed, setUnclaimed] = React.useState<
        { device_id: string; mac_address: string; user_code: string }[]
    >([]);
    const [busyDeviceId, setBusyDeviceId] = React.useState<string | null>(null);

    const handleSave = () => {
        if (selectedUser.user_info.user_type === "doctor") {
            doctorFormRef.current?.submitForm();
        } else {
            userFormRef.current?.submitForm();
        }
    };

    const checkIfUserHasDevice = useCallback(async () => {
        setIsConnected(
            await doesUserHaveADevice(supabase, selectedUser.user_id)
        );
    }, [selectedUser.user_id, supabase]);

    React.useEffect(() => {
        checkIfUserHasDevice();
    }, [checkIfUserHasDevice]);

    // A board registers itself the moment it gets online, so poll while the user
    // is waiting on this screen -- it should appear a few seconds after it joins
    // their WiFi, without them having to reload.
    React.useEffect(() => {
        if (isConnected) {
            setUnclaimed([]);
            return;
        }
        let cancelled = false;
        const load = async () => {
            const devices = await listUnclaimedDevices();
            if (!cancelled) {
                setUnclaimed(devices as typeof unclaimed);
            }
        };
        load();
        const timer = setInterval(load, 5000);
        return () => {
            cancelled = true;
            clearInterval(timer);
        };
    }, [isConnected]);

    const handleClaim = async (deviceId: string) => {
        setBusyDeviceId(deviceId);
        const ok = await claimDeviceAction(deviceId);
        setBusyDeviceId(null);
        if (!ok) {
            setError("Could not claim that device - someone may have just taken it");
            return;
        }
        setError("");
        checkIfUserHasDevice();
    };

    const handleUnbind = async () => {
        const deviceId = selectedUser.device?.device_id;
        if (!deviceId) return;
        setBusyDeviceId(deviceId);
        const ok = await unbindDeviceAction(deviceId);
        setBusyDeviceId(null);
        if (ok) {
            setError("");
            checkIfUserHasDevice();
        }
    };


    const [volume, setVolume] = React.useState([
        selectedUser.device?.volume ?? 50,
    ]);

    const debouncedUpdateVolume = _.debounce(async () => {
        if (selectedUser.device?.device_id) {
            await updateDevice(
                supabase,
                { volume: volume[0] },
                selectedUser.device.device_id
            );
        }
    }, 1000); // Adjust the debounce delay as needed

    const updateVolume = (value: number[]) => {
        setVolume(value);
        debouncedUpdateVolume();
    };

    const onSave = async (values: any, userType: "doctor" | "user", userId: string) => {

        await updateUser(
            supabase,
            {
                supervisee_age: values.supervisee_age,
                supervisee_name: values.supervisee_name,
                supervisee_persona: values.supervisee_persona,
                user_info: {
                    user_type: userType,
                    user_metadata: values,
                },  
            },
            userId);
            toast({
                description: "Your prefereces have been saved!",
            });
    }

    return (
        <>
            <GeneralUserForm
                    selectedUser={selectedUser}
                    userId={selectedUser.user_id}
                    heading={heading}
                    onSave={onSave}
                    onClickCallback={() => handleSave()}
                />

            <div className="space-y-4 max-w-screen-sm mt-12">
                <h2 className="text-lg font-semibold border-b border-gray-200 pb-2">
                    Device settings
                </h2>
                {skipDeviceRegistration && <div className="flex flex-col text-purple-500 text-xs gap-2">You don't need to register your device because NEXT_PUBLIC_SKIP_DEVICE_REGISTRATION is set to True.</div>}
                <div className="flex flex-col gap-6">
                <div className="flex flex-col gap-2">
                    <div className="flex flex-row items-center gap-2">
                    <Label className="text-sm font-medium text-gray-700">
                    Register your device
                    </Label>
                        <div 
                            className={`rounded-full flex-shrink-0 h-2 w-2 ${
                                isConnected ? 'bg-green-500' : 'bg-amber-500'
                            }`} 
                        />    

                        </div>

                        {!isConnected && (
                            <div className="flex flex-col gap-2 mt-2">
                                {unclaimed.length === 0 ? (
                                    <div className="rounded-md border border-dashed border-gray-200 p-3 text-xs text-gray-500">
                                        <p className="font-medium text-gray-700">No devices found yet.</p>
                                        <p className="mt-1">
                                            Power on your device, join its
                                            {" "}<span className="font-mono">ELATO-DEVICE</span>{" "}
                                            WiFi network, open
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
                        )}

                        {isConnected && (
                            <div className="flex flex-row items-center justify-between rounded-md border border-gray-200 p-3 mt-2">
                                <span className="font-mono text-xs text-gray-500">
                                    {selectedUser.device?.mac_address ?? "Device linked"}
                                </span>
                                <Button
                                    size="sm"
                                    variant="outline"
                                    disabled={busyDeviceId !== null}
                                    onClick={handleUnbind}
                                >
                                    Unbind
                                </Button>
                            </div>
                        )}

                        <div className="flex flex-row items-center gap-2 mt-2">
                            <Input
                                value={deviceCode}
                                disabled={isConnected}
                                onChange={(e) =>
                                    setDeviceCode(
                                        e.target.value.toUpperCase().replace(/[^A-Z2-9]/g, ""),
                                    )
                                }
                                placeholder={isConnected ? "**********" : "Or enter the device code"}
                                maxLength={6}
                            />
                            <Button
                                size="sm"
                                variant="outline"
                                disabled={isConnected || deviceCode.length !== 6}
                                onClick={async () => {
                                    const result = await connectUserToDevice(selectedUser.user_id, deviceCode);
                                    if (!result) {
                                        setError("Error registering device");
                                    } else {
                                        setError("");
                                    }
                                    checkIfUserHasDevice();
                                }}
                            >
                                Register
                            </Button>
                        </div>
                        <p className="text-xs text-gray-400">
                            {isConnected ? <span className="font-medium text-gray-800">Registered!</span> :
                                error ? <span className="text-red-500">{error}.</span> :
                                "Enter your device code to register it."
                        }
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
                    {isConnected && <div className="flex flex-col gap-4 mt-6">
                        <Label className="text-sm font-medium text-gray-700">
                            Device volume
                        </Label>
                        <div className="flex flex-row gap-2 items-center flex-nowrap">
                            <Slider
                                value={volume}
                                onValueChange={updateVolume}
                                className="sm:w-1/2"
                                defaultValue={[50]}
                                max={100}
                                min={1}
                                step={1}
                            />
                            <p className="text-gray-500 text-sm">{volume}%</p>
                        </div>
                    </div>}
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