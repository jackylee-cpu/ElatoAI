interface HomePageSubtitlesProps {
    user: IUser;
    page: "home" | "settings" | "create";
    languageCode?: string;
}

const HomePageSubtitles: React.FC<HomePageSubtitlesProps> = ({
    user,
    page,
    languageCode = "en-US",
}) => {
    if (page === "home") {
        return (
            <p className="text-sm text-gray-600">
                {"Talk to any AI character below"}
            </p>
        );
    } else if (page === "settings") {
        return (
            <p className="text-sm text-gray-600">
                {"You can update your settings below"}
            </p>
        );
    } else if (page === "create") {
        return (
            <p className="text-sm text-gray-600">
                {"Customize your character's voice, language, accent and much more"}
            </p>
        );
    }

    // if they are a regular user
    // return <CreditsRemaining user={user} languageCode={languageCode} />;
};

export default HomePageSubtitles;
