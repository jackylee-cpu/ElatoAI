import { Button } from "@/components/ui/button";
import { usePathname } from "next/navigation";
import Image from "next/image";
import Link from "next/link";

interface LeftNavbarButtonsProps {
    user: IUser | null;
}

export default function LeftNavbarButtons({ user }: LeftNavbarButtonsProps) {
    const isDoctor = user?.user_info.user_type === "doctor";
    const pathname = usePathname();

    let firstWordOfHospital = '';
    if (isDoctor) {
        const hospitalName = (user?.user_info.user_metadata as IDoctorMetadata).hospital_name; 
        firstWordOfHospital = hospitalName ? hospitalName.split(' ')[0] : '';
    }

    const isHome = pathname.includes("/home");

    const shouldShowHospital = isDoctor && firstWordOfHospital.length && isHome;

    return (
        <div className="flex flex-row gap-4 sm:gap-10 items-center">
        <Button
            variant="outline"
            className="flex flex-row gap-2 items-center px-4 py-2 rounded-lg"
            asChild
            aria-label="Go to Home page"
            title="Click to go to Home page"
        >
            <Link href="/">
                <p className="flex items-center font-luckiestGuy tracking-widest text-xl mt-1">
                    <span>{shouldShowHospital ? firstWordOfHospital : "Elato"}</span>
                </p>
                <Image src="/logos/elato.png" alt="Elato Logo" width={24} height={24} />
            </Link>
        </Button>
    </div>
    );
}
