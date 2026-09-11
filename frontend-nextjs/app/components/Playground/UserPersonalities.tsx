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
    const hasVisibleCharacters = [...myPersonalities, ...allPersonalities].some(
        (personality) =>
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
