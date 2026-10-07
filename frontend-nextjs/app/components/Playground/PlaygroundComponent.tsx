"use client";

import React, { useState } from "react";
import Link from "next/link";
import { createClient } from "@/utils/supabase/client";
import { updateUser } from "@/db/users";
import { refreshDeviceSession } from "@/app/actions";
import PersonalityFilters from "./PersonalityFilters";
import { TranscriptProvider } from "../Realtime/contexts/TranscriptContext";
import { EventProvider } from "../Realtime/contexts/EventContext";
import App from "../Realtime/App";
import { defaultPersonalityId } from "@/lib/data";
import UserPersonalities from "./UserPersonalities";
import { PlaygroundBottomNav } from "./PlaygroundBottomNav";
import { PlaygroundMicButton } from "./PlaygroundMicButton";
import { SlidersHorizontal } from "lucide-react";
import { OptionRow } from "./OptionRow";

interface PlaygroundProps {
    currentUser: IUser;
    allPersonalities: IPersonality[];
    myPersonalities: IPersonality[];
    ips: IIp[];
    isAdmin?: boolean;
}

const DEFAULT_IP_KEY = "house";
const ipKeyOf = (personality: IPersonality | undefined) =>
    personality?.ip_key ?? DEFAULT_IP_KEY;

const initialFilterForUser = (user: IUser): PersonalityFilter[] => {
    const personality = user.personality;
    if (personality?.is_story) return ["is_story"];
    if (personality?.is_child_voice) return ["is_child_voice"];
    return ["is_story"];
};

const Playground: React.FC<PlaygroundProps> = ({
    currentUser,
    allPersonalities,
    myPersonalities,
    ips,
    isAdmin = false,
}) => {
    const supabase = createClient();

    const [personalityIdState, setPersonalityIdState] = useState<string>(
        currentUser.personality!.personality_id ?? defaultPersonalityId
    );

    const [selectedFilters, setSelectedFilters] = useState<PersonalityFilter[]>(
        () => initialFilterForUser(currentUser)
    );

    const findPersonality = (personalityId: string) =>
        allPersonalities.find((p) => p.personality_id === personalityId) ??
        myPersonalities.find((p) => p.personality_id === personalityId) ??
        (currentUser.personality?.personality_id === personalityId
            ? currentUser.personality
            : undefined);

    // Switching IP is picking one of its characters. The tabs only narrow the
    // list, so they appear once there is more than one IP to choose from.
    // A hidden IP's characters leave the picker with it; a database without
    // IPs at all lists everything, as before.
    const visibleIps = ips.filter((ip) => !ip.is_hidden);
    const visibleIpKeys = new Set(visibleIps.map((ip) => ip.ip_key));
    const showIpTabs = visibleIps.length > 1;
    const [ipKeyState, setIpKeyState] = useState<string>(() => {
        const current = ipKeyOf(findPersonality(personalityIdState));
        return visibleIpKeys.has(current) ? current : (visibleIps[0]?.ip_key ?? current);
    });
    const inShownIp = (personality: IPersonality) => {
        const ipKey = ipKeyOf(personality);
        if (ips.length > 0 && !visibleIpKeys.has(ipKey)) return false;
        return !showIpTabs || ipKey === ipKeyState;
    };

    const onPersonalityPicked = async (personalityIdPicked: string) => {
        setPersonalityIdState(personalityIdPicked);
        // The character carries its own mode and style (set on the admin
        // page), so picking it is the whole choice.
        await updateUser(
            supabase,
            {
                personality_id: personalityIdPicked,
            },
            currentUser.user_id
        );
        // The device reads its character when a session starts, so drop the
        // current one -- it reconnects about a second later as the new
        // character. Best effort: if this fails the change still lands the next
        // time the device connects.
        void refreshDeviceSession();
    };


    return (
        <TranscriptProvider>
            <EventProvider>
                <>
                    <div className="relative z-10 mx-auto flex h-full w-full max-w-5xl flex-col px-4 pt-[max(1.25rem,env(safe-area-inset-top))] md:px-8 md:pt-8">
                        <header className="relative flex h-14 shrink-0 items-center justify-center md:h-16">
                            {isAdmin && (
                                <Link
                                    href="/home/admin"
                                    className="absolute left-0 hidden items-center gap-1 rounded-full bg-white/70 px-3 py-1.5 text-xs font-medium text-gray-600 shadow-sm backdrop-blur-sm hover:bg-white md:flex"
                                >
                                    <SlidersHorizontal size={14} />
                                    Admin
                                </Link>
                            )}
                            <h1 className="font-fredoka text-[28px] font-semibold tracking-tight text-gray-900 md:text-[32px]">
                                Playground
                            </h1>
                        </header>

                        {showIpTabs && (
                            <div className="mx-auto w-full max-w-[400px] shrink-0 pb-3">
                                <OptionRow
                                    label="World"
                                    value={ipKeyState}
                                    onChange={(next) => next && setIpKeyState(next)}
                                    options={visibleIps.map((ip) => ({
                                        key: ip.ip_key,
                                        label: ip.name,
                                        description: ip.description,
                                    }))}
                                />
                            </div>
                        )}

                        <div className="shrink-0 pb-4 pt-1">
                            <PersonalityFilters
                                setSelectedFilters={setSelectedFilters}
                                selectedFilters={selectedFilters}
                                languageState={"en-US"}
                            />
                        </div>

                        <div className="scrollbar-hide flex-1 overflow-y-auto pb-32 md:pb-36">
                            <UserPersonalities
                                selectedFilters={selectedFilters}
                                onPersonalityPicked={onPersonalityPicked}
                                personalityIdState={personalityIdState}
                                languageState={"en-US"}
                                disableButtons={false}
                                allPersonalities={allPersonalities.filter(inShownIp)}
                                myPersonalities={myPersonalities.filter(inShownIp)}
                            />
                        </div>
                    </div>

                    <PlaygroundBottomNav>
                        <App
                            personalityIdState={personalityIdState}
                            renderTrigger={({
                                sessionStatus,
                                onToggleConnection,
                                disabled,
                            }) => (
                                <PlaygroundMicButton
                                    sessionStatus={sessionStatus}
                                    onToggleConnection={onToggleConnection}
                                    disabled={disabled}
                                />
                            )}
                        />
                    </PlaygroundBottomNav>
                </>
            </EventProvider>
        </TranscriptProvider>
    );
};

export default Playground;
