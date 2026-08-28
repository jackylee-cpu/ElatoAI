import PremiumBadge from "../PremiumBadge";
import { NavbarDropdownMenu } from "./NavbarDropdownMenu";

interface NavbarButtonsProps {
    user: IUser | null;
    stars: number | null;
    isHome: boolean;
}

const NavbarButtons: React.FC<NavbarButtonsProps> = ({
    user,
    stars,
    isHome,
}) => {
    return (
        <div
            className={`flex flex-row sm:gap-2 ${
                isHome ? "gap-2" : ""
            } items-center font-bold text-sm `}
        >
            {isHome && user && (
                <div>
                    <PremiumBadge currentUserId={user.user_id} />
                </div>
            )}
            <NavbarDropdownMenu user={user} stars={stars} />
        </div>
    );
};

export default NavbarButtons;
