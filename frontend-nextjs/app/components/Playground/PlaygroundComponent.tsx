"use client";

import React, { useState } from "react";
import Image from "next/image";
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
import { playgroundAssets } from "./playgroundAssets";
import { PlaygroundBottomNav } from "./PlaygroundBottomNav";
import { PlaygroundMicButton } from "./PlaygroundMicButton";
import { SlidersHorizontal } from "lucide-react";

interface PlaygroundProps {
    currentUser: IUser;
    allPersonalities: IPersonality[];
    myPersonalities: IPersonality[];
    isAdmin?: boolean;
}

const initialFilterForUser = (user: IUser): PersonalityFilter[] => {
    const personality = user.personality;
    if (personality?.is_story) return ["is_story"];
    if (personality?.is_child_voice) return ["is_child_voice"];
    if (personality?.is_doctor) return ["is_doctor"];
    return ["is_story"];
};

const Playground: React.FC<PlaygroundProps> = ({
    currentUser,
    allPersonalities,
    myPersonalities,
    isAdmin = false,
}) => {
    const isDoctor = currentUser.user_info.user_type === "doctor";

    const supabase = createClient();

    const [personalityIdState, setPersonalityIdState] = useState<string>(
        currentUser.personality!.personality_id ?? defaultPersonalityId
    );

    const [selectedFilters, setSelectedFilters] = useState<PersonalityFilter[]>(
        () => initialFilterForUser(currentUser)
    );

    const onPersonalityPicked = async (personalityIdPicked: string) => {
        setPersonalityIdState(personalityIdPicked);
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
                <div className="relative h-dvh w-full overflow-hidden bg-[#d4e8f8]">
                    <Image
                        src={playgroundAssets.bg}
                        alt=""
                        fill
                        priority
                        sizes="100vw"
                        className="object-cover object-top"
                    />

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
                            <Link
                                href="/home/create"
                                className="absolute right-0 top-1/2 -translate-y-1/2 transition-transform hover:scale-105 active:scale-95"
                                aria-label="Create character"
                            >
                                <Image
                                    src={playgroundAssets.plus}
                                    alt=""
                                    width={44}
                                    height={44}
                                    className="h-10 w-10 object-contain md:h-11 md:w-11"
                                    priority
                                />
                            </Link>
                        </header>

                        <div className="shrink-0 pb-4 pt-1">
                            <PersonalityFilters
                                setSelectedFilters={setSelectedFilters}
                                selectedFilters={selectedFilters}
                                languageState={"en-US"}
                                currentUser={currentUser}
                            />
                        </div>

                        <div className="scrollbar-hide flex-1 overflow-y-auto pb-32 md:pb-36">
                            <UserPersonalities
                                selectedFilters={selectedFilters}
                                onPersonalityPicked={onPersonalityPicked}
                                personalityIdState={personalityIdState}
                                languageState={"en-US"}
                                disableButtons={false}
                                allPersonalities={
                                    isDoctor
                                        ? allPersonalities.filter(
                                              (p) => p.is_story || p.is_doctor
                                          )
                                        : allPersonalities
                                }
                                myPersonalities={myPersonalities}
                            />
                        </div>
                    </div>

                    <PlaygroundBottomNav>
                        <App
                            personalityIdState={personalityIdState}
                            isDoctor={isDoctor}
                            userId={currentUser.user_id}
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
                </div>
            </EventProvider>
        </TranscriptProvider>
    );
};

export default Playground;
