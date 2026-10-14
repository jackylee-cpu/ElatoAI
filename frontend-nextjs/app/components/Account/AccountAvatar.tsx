import { MeIcon } from "../Playground/icons";
import { cn } from "@/lib/utils";

export function AccountAvatar({
    src,
    className,
}: {
    src?: string | null;
    className?: string;
}) {
    return (
        <div
            className={cn(
                "relative flex h-[72px] w-[72px] shrink-0 items-center justify-center overflow-hidden rounded-full bg-[#EEF3FF] ring-4 ring-[#EEF3FF]/60",
                className
            )}
        >
            {src ? (
                // Avatars come from Google or Supabase storage; a plain <img>
                // avoids listing every host in next.config images.
                <img src={src} alt="" className="h-full w-full object-cover" />
            ) : (
                <MeIcon className="h-1/2 w-1/2" />
            )}
        </div>
    );
}
