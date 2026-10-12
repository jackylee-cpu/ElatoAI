"use client";

import { useState } from "react";
import { createClient } from "@/utils/supabase/client";
import { updateUser } from "@/db/users";
import { useToast } from "@/components/ui/use-toast";
import { ChevronDownIcon, UsFlagIcon } from "../Playground/icons";
import {
    Select,
    SelectContent,
    SelectItem,
    SelectTrigger,
} from "@/components/ui/select";
import Twemoji from "react-twemoji";
import { Loader2 } from "lucide-react";
import { cn } from "@/lib/utils";

interface MyInfoFormProps {
    selectedUser: IUser;
    allLanguages: ILanguage[];
    allRegions: IRegion[];
}

const fieldClass =
    "w-full rounded-[20px] border-0 bg-white px-4 py-3.5 text-base text-gray-900 shadow-[0_4px_16px_rgba(80,120,180,0.08)] outline-none placeholder:text-gray-300 focus-visible:ring-2 focus-visible:ring-[#4C74F6]/30";

const labelClass = "mb-2 block text-sm font-medium text-gray-600";

function LanguageFlag({
    code,
    flag,
}: {
    code?: string;
    flag?: string;
}) {
    if (code === "en-US") {
        return (
            <UsFlagIcon className="h-6 w-6 shrink-0" />
        );
    }

    return (
        <span className="flex h-6 w-6 shrink-0 items-center justify-center overflow-hidden rounded-full text-xl leading-none">
            <Twemoji options={{ className: "twemoji h-6 w-6 flex-shrink-0" }}>
                {flag ?? "🌐"}
            </Twemoji>
        </span>
    );
}

export default function MyInfoForm({
    selectedUser,
    allLanguages,
    allRegions,
}: MyInfoFormProps) {
    const supabase = createClient();
    const { toast } = useToast();
    const [name, setName] = useState(selectedUser.supervisee_name ?? "");
    const [age, setAge] = useState(
        selectedUser.supervisee_age ? String(selectedUser.supervisee_age) : ""
    );
    const [description, setDescription] = useState(
        selectedUser.supervisee_persona ?? ""
    );
    const [language, setLanguage] = useState(
        selectedUser.language_code ?? "zh-HK"
    );
    // Empty until chosen. The voice server then uses its own default place,
    // and saving leaves the column NULL rather than writing a guess.
    const [region, setRegion] = useState(selectedUser.region_code ?? "");
    const [saving, setSaving] = useState(false);

    const languageSelected = allLanguages.find((item) => item.code === language);
    const regionSelected = allRegions.find((item) => item.code === region);

    const handleSave = async () => {
        const trimmedName = name.trim();
        const ageNumber = Number(age);
        if (!trimmedName) {
            toast({ description: "Please enter a name.", variant: "destructive" });
            return;
        }
        if (!Number.isFinite(ageNumber) || ageNumber < 1 || ageNumber > 18) {
            toast({
                description: "Please enter an age between 1 and 18.",
                variant: "destructive",
            });
            return;
        }

        setSaving(true);
        await updateUser(
            supabase,
            {
                supervisee_name: trimmedName,
                supervisee_age: ageNumber,
                supervisee_persona: description.trim(),
                language_code: language,
                ...(region ? { region_code: region } : {}),
            },
            selectedUser.user_id
        );
        toast({ description: "Your preferences have been saved!" });
        setSaving(false);
    };

    return (
        <div className="flex h-full min-h-0 flex-col">
            <div className="scrollbar-hide flex-1 space-y-5 overflow-y-auto pb-4">
                <label className="block">
                    <span className={labelClass}>Name</span>
                    <input
                        value={name}
                        onChange={(event) => setName(event.target.value)}
                        placeholder="Tom"
                        maxLength={50}
                        className={fieldClass}
                    />
                </label>

                <label className="block">
                    <span className={labelClass}>Age</span>
                    <input
                        type="number"
                        inputMode="numeric"
                        min={1}
                        max={18}
                        value={age}
                        onChange={(event) => setAge(event.target.value)}
                        placeholder="10"
                        className={cn(
                            fieldClass,
                            "[appearance:textfield] [&::-webkit-inner-spin-button]:appearance-none [&::-webkit-outer-spin-button]:appearance-none"
                        )}
                    />
                </label>

                <label className="block">
                    <span className={labelClass}>Description</span>
                    <textarea
                        value={description}
                        onChange={(event) => setDescription(event.target.value)}
                        placeholder="Tom loves playing guitar and enjoys watching Agadmar."
                        rows={5}
                        maxLength={500}
                        className={cn(fieldClass, "min-h-[140px] resize-none")}
                    />
                </label>

                <div>
                    <span className={labelClass}>Character&apos;s language.</span>
                    <Select value={language} onValueChange={setLanguage}>
                        <SelectTrigger
                            className={cn(
                                fieldClass,
                                "flex h-auto items-center justify-between gap-3 [&>span]:line-clamp-none [&>span]:flex [&>span]:items-center [&>span]:gap-3 [&>svg]:hidden"
                            )}
                        >
                            <LanguageFlag code={languageSelected?.code} flag={languageSelected?.flag} />
                            <span className="min-w-0 flex-1 truncate text-left text-base text-gray-900">
                                {languageSelected?.name ?? "English"}
                            </span>
                            <ChevronDownIcon className="h-4 w-4 shrink-0 opacity-70" />
                        </SelectTrigger>
                        <SelectContent className="rounded-2xl">
                            {allLanguages.map((item) => (
                                <SelectItem
                                    key={item.language_id}
                                    value={item.code}
                                    className="rounded-xl py-2"
                                >
                                    <span className="flex items-center gap-2">
                                        <LanguageFlag
                                            code={item.code}
                                            flag={item.flag}
                                        />
                                        <span>{item.name}</span>
                                    </span>
                                </SelectItem>
                            ))}
                        </SelectContent>
                    </Select>
                </div>

                {allRegions.length > 0 && (
                    <div>
                        <span className={labelClass}>Where you live</span>
                        <Select value={region} onValueChange={setRegion}>
                            <SelectTrigger
                                className={cn(
                                    fieldClass,
                                    "flex h-auto items-center justify-between gap-3 [&>span]:line-clamp-none [&>span]:flex [&>span]:items-center [&>span]:gap-3 [&>svg]:hidden"
                                )}
                            >
                                <LanguageFlag flag={regionSelected?.flag} />
                                <span
                                    className={cn(
                                        "min-w-0 flex-1 truncate text-left text-base",
                                        regionSelected ? "text-gray-900" : "text-gray-300"
                                    )}
                                >
                                    {regionSelected?.name ?? "Choose a city"}
                                </span>
                                <ChevronDownIcon className="h-4 w-4 shrink-0 opacity-70" />
                            </SelectTrigger>
                            <SelectContent className="rounded-2xl">
                                {allRegions.map((item) => (
                                    <SelectItem
                                        key={item.code}
                                        value={item.code}
                                        className="rounded-xl py-2"
                                    >
                                        <span className="flex items-center gap-2">
                                            <LanguageFlag flag={item.flag} />
                                            <span>{item.name}</span>
                                        </span>
                                    </SelectItem>
                                ))}
                            </SelectContent>
                        </Select>
                        <p className="mt-2 px-1 text-xs text-gray-400">
                            So your character knows your time and weather.
                        </p>
                    </div>
                )}
            </div>

            <div
                className="shrink-0 pt-3"
                style={{
                    paddingBottom: "max(0.75rem, env(safe-area-inset-bottom))",
                }}
            >
                <button
                    type="button"
                    onClick={handleSave}
                    disabled={saving}
                    className="flex h-14 w-full items-center justify-center rounded-full bg-gradient-to-r from-[#5B6CFF] to-[#3D8BFF] text-base font-semibold tracking-[0.18em] text-white shadow-[0_10px_24px_rgba(80,110,230,0.35)] transition-transform hover:scale-[1.01] active:scale-[0.99] disabled:opacity-70"
                >
                    {saving ? (
                        <Loader2 className="h-5 w-5 animate-spin" />
                    ) : (
                        "SAVE"
                    )}
                </button>
            </div>
        </div>
    );
}
