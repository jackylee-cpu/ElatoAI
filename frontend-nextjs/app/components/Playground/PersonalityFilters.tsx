import { Dispatch, SetStateAction } from "react";
import { cn } from "@/lib/utils";

interface PersonalityFiltersProps {
    setSelectedFilters: Dispatch<SetStateAction<PersonalityFilter[]>>;
    selectedFilters: PersonalityFilter[];
    languageState: string;
}

const PersonalityFilters = ({
    setSelectedFilters,
    selectedFilters,
}: PersonalityFiltersProps) => {
    const active = selectedFilters[0] ?? "is_story";

    const tabs: { value: PersonalityFilter; label: string }[] = [
        { value: "is_story", label: "Story" },
        { value: "is_child_voice", label: "Children" },
    ];

    return (
        <div
            className={cn(
                "mx-auto grid w-full max-w-[340px] rounded-full bg-white/90 p-1 shadow-[0_4px_16px_rgba(80,120,180,0.08)] md:max-w-[400px]",
                tabs.length === 2 ? "grid-cols-2" : "grid-cols-3"
            )}
        >
            {tabs.map((tab) => {
                const isActive = active === tab.value;
                return (
                    <button
                        key={tab.value}
                        type="button"
                        onClick={() => setSelectedFilters([tab.value])}
                        className={cn(
                            "rounded-full py-2 text-sm transition-all md:text-base",
                            isActive
                                ? "bg-white font-semibold text-gray-900 shadow-sm"
                                : "font-medium text-gray-400 hover:text-gray-600"
                        )}
                    >
                        {tab.label}
                    </button>
                );
            })}
        </div>
    );
};

export default PersonalityFilters;
