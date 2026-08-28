import {
    Menu,
    LogIn,
    HomeIcon,
} from "lucide-react";
import Link from "next/link";
import { Button } from "@/components/ui/button";
import {
    DropdownMenu,
    DropdownMenuContent,
    DropdownMenuGroup,
    DropdownMenuItem,
    DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import PremiumBadge from "../PremiumBadge";
import { useEffect, useState } from "react";
import { isPremiumUser } from "@/app/actions";
import { DropdownMenuLabel } from "@radix-ui/react-dropdown-menu";
interface NavbarMenuButtonProps {
    user: IUser | null;
    stars: number | null;
}
const ICON_SIZE = 22;

export function NavbarDropdownMenu({ user }: NavbarMenuButtonProps) {
    const [premiumUser, setPremiumUser] = useState(false);

    useEffect(() => {
        const setUserPremium = async () => {
            if (user) {
                const isPremium = await isPremiumUser(user.user_id);
                setPremiumUser(isPremium ?? false);
            }
        };
        setUserPremium();
    }, [user]);

    const LoggedInItems: React.FC = () => {
        return (
            <DropdownMenuItem>
                <Link
                    href="/home"
                    passHref
                    className="flex flex-row gap-2 w-full"
                >
                    <HomeIcon size={ICON_SIZE} />
                    <span>Home</span>
                </Link>
            </DropdownMenuItem>
        );
    };

    const LoggedOutItems: React.FC = () => {
        return (
            <DropdownMenuItem>
                <Link
                    href="/login"
                    passHref
                    className="flex flex-row gap-2 w-full"
                >
                    <LogIn size={ICON_SIZE} />
                    <span>Login</span>
                </Link>
            </DropdownMenuItem>
        );
    };

    return (
        <DropdownMenu
            onOpenChange={(open) => {
                if (!open) {
                    // Remove focus from any active element when dropdown closes
                    document.activeElement instanceof HTMLElement &&
                        document.activeElement.blur();
                }
            }}
        >
            <DropdownMenuTrigger asChild>
                <Button
                    variant="ghost"
                    size="sm"
                    className="flex flex-row gap-2 items-center rounded-full 
                    focus:outline-none focus:ring-0 focus:ring-transparent 
                    focus-visible:outline-none focus-visible:ring-0 focus-visible:ring-transparent 
                    shadow-none focus:shadow-none focus-visible:shadow-none"                    >
                    <Menu size={20} />
                    <span className="hidden sm:flex font-normal">
                        {user ? "Home" : "Login"}
                    </span>
                </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent
                className="w-60 p-2 sm:mt-2 rounded-lg"
                side="bottom"
                align="end"
            >
                {!!user && premiumUser ? (
                    <DropdownMenuLabel className="flex w-full justify-center">
                        <PremiumBadge currentUserId={user.user_id} displayText />
                    </DropdownMenuLabel>
                ) : null}
                <DropdownMenuGroup>
                    {user ? <LoggedInItems /> : <LoggedOutItems />}
                </DropdownMenuGroup>
            </DropdownMenuContent>
        </DropdownMenu>
    );
}
