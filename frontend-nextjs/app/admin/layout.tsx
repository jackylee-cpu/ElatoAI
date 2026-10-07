import Image from "next/image";
import { playgroundAssets } from "@/app/components/Playground/playgroundAssets";

export const dynamic = "force-dynamic";

/**
 * The playground's backdrop, without the parents' navigation.
 *
 * The console layout and every server action check the role; middleware.ts
 * checks before either.
 */
export default function AdminRootLayout({
    children,
}: {
    children: React.ReactNode;
}) {
    return (
        <div className="relative h-dvh w-full overflow-hidden bg-[#d4e8f8]">
            <Image
                src={playgroundAssets.bg}
                alt=""
                fill
                priority
                sizes="100vw"
                className="object-cover object-top"
            />
            {children}
        </div>
    );
}
