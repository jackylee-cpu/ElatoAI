import CharacterSection from "./CharacterSection";

interface UserPersonalitiesProps {
    onPersonalityPicked: (personalityIdPicked: string) => void;
    allPersonalities: IPersonality[];
    personalityIdState: string;
    languageState: string;
    disableButtons: boolean;
    selectedFilters: PersonalityFilter[];
    myPersonalities: IPersonality[];
}

const UserPersonalities: React.FC<UserPersonalitiesProps> = ({
    onPersonalityPicked,
    allPersonalities,
    personalityIdState,
    languageState,
    disableButtons,
    selectedFilters,
    myPersonalities,
}) => {
    // My Characters ignore the tabs, so having any of them is enough for the
    // screen to have something on it.
    const hasVisibleCharacters =
        myPersonalities.length > 0 ||
        allPersonalities.some((personality) =>
            selectedFilters.every((filter) => personality[filter] === true)
        );

    if (!hasVisibleCharacters) {
        return (
            <p className="pt-16 text-center text-sm text-gray-500">
                No characters in this category
            </p>
        );
    }

    return (
        <div className="flex w-full flex-col gap-6">
            {myPersonalities.length > 0 && (
                <CharacterSection
                    selectedFilters={selectedFilters}
                    allPersonalities={myPersonalities}
                    languageState={languageState}
                    personalityIdState={personalityIdState}
                    onPersonalityPicked={onPersonalityPicked}
                    title={"My Characters"}
                    disableButtons={disableButtons}
                    ignoreFilters
                />
            )}
            <CharacterSection
                allPersonalities={allPersonalities}
                languageState={languageState}
                personalityIdState={personalityIdState}
                onPersonalityPicked={onPersonalityPicked}
                title={"Characters"}
                disableButtons={disableButtons}
                selectedFilters={selectedFilters}
            />
        </div>
    );
};

export default UserPersonalities;
