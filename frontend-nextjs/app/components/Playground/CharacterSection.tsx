import Image from "next/image";
import { cn, getPersonalityImageSrc } from "@/lib/utils";
import { EmojiComponent } from "./EmojiImage";
import { CheckIcon } from "./icons";

interface CharacterSectionProps {
    allPersonalities: IPersonality[];
    languageState: string;
    personalityIdState: string;
    onPersonalityPicked: (personalityIdPicked: string) => void;
    title: string;
    disableButtons: boolean;
    selectedFilters: PersonalityFilter[];
}

const formatCharacterName = (personality: IPersonality) =>
    personality.title.replace(/\s+/g, "-").toUpperCase();

const CharacterSection = ({
    allPersonalities,
    personalityIdState,
    onPersonalityPicked,
    title,
    disableButtons,
    selectedFilters,
}: CharacterSectionProps) => {
    const filteredPersonalities = allPersonalities.filter((personality) => {
        return selectedFilters.every((filter) => {
            return personality[filter] === true;
        });
    });

    if (filteredPersonalities.length === 0) {
        return null;
    }

    const hideTitle = title === "Characters";

    return (
        <div className="flex w-full flex-col gap-3">
            {!hideTitle && (
                <p className="px-1 text-xs font-medium uppercase tracking-wider text-gray-500">
                    {title}
                </p>
            )}
            <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 sm:gap-4 lg:grid-cols-4 lg:gap-5">
                {filteredPersonalities.map((personality) => {
                    const isCurrentPersonality =
                        personalityIdState === personality.personality_id;
                    return (
                        <button
                            key={personality.personality_id}
                            type="button"
                            disabled={disableButtons}
                            onClick={() =>
                                onPersonalityPicked(personality.personality_id!)
                            }
                            className={cn(
                                "flex flex-col items-center rounded-[28px] bg-white/90 px-3 pb-3 pt-4 shadow-[0_8px_24px_rgba(80,120,180,0.10)] transition-transform",
                                "border-[2.5px]",
                                isCurrentPersonality
                                    ? "border-[#4C74F6]"
                                    : "border-transparent hover:border-[#4C74F6]/40",
                                disableButtons
                                    ? "cursor-not-allowed opacity-70"
                                    : "cursor-pointer hover:scale-[1.02] active:scale-[0.98]"
                            )}
                            aria-pressed={isCurrentPersonality}
                            aria-label={personality.title}
                        >
                            <div className="relative mx-auto h-[110px] w-[110px] shrink-0 sm:h-[124px] sm:w-[124px] md:h-[140px] md:w-[140px]">
                                <div className="absolute inset-0 overflow-hidden rounded-full bg-[#f3f6fb]">
                                    {personality.creator_id === null ? (
                                        <Image
                                            src={getPersonalityImageSrc(
                                                personality.key
                                            )}
                                            alt={personality.title}
                                            fill
                                            sizes="(max-width: 640px) 40vw, (max-width: 1024px) 22vw, 160px"
                                            className="object-cover object-top"
                                        />
                                    ) : (
                                        <div className="flex h-full w-full items-center justify-center">
                                            <EmojiComponent
                                                personality={personality}
                                                size={72}
                                            />
                                        </div>
                                    )}
                                </div>
                                {isCurrentPersonality && (
                                    <CheckIcon className="absolute -right-0.5 -top-0.5 z-10 h-7 w-7" />
                                )}
                            </div>
                            <span className="mt-3 max-w-full truncate text-center text-[11px] font-medium tracking-[0.04em] text-[#7A8AA0] md:text-xs">
                                {formatCharacterName(personality)}
                            </span>
                        </button>
                    );
                })}
            </div>
        </div>
    );
};

export default CharacterSection;
