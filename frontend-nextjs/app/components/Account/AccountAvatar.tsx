"use client";

import { useEffect, useRef, useState } from "react";
import { MeIcon } from "../Playground/icons";
import { cn } from "@/lib/utils";

export function AccountAvatar({
    src,
    className,
}: {
    src?: string | null;
    className?: string;
}) {
    // An avatar URL can stop resolving (an expired Google link, a deleted
    // file); show the placeholder rather than a broken image. Keyed on src so
    // a new URL gets another try.
    const [failedSrc, setFailedSrc] = useState<string | null>(null);
    const showImage = !!src && src !== failedSrc;
    const imgRef = useRef<HTMLImageElement>(null);

    // React 18 drops an error event that fires before hydration, so a server-
    // rendered <img> that already failed would stay broken; check it here.
    useEffect(() => {
        const img = imgRef.current;
        if (src && img?.complete && img.naturalWidth === 0) {
            setFailedSrc(src);
        }
    }, [src]);

    return (
        <div
            className={cn(
                "relative flex h-[72px] w-[72px] shrink-0 items-center justify-center overflow-hidden rounded-full bg-[#EEF3FF] ring-4 ring-[#EEF3FF]/60",
                className
            )}
        >
            {showImage ? (
                // Avatars come from Google or Supabase storage; a plain <img>
                // avoids listing every host in next.config images.
                <img
                    ref={imgRef}
                    src={src}
                    alt=""
                    className="h-full w-full object-cover"
                    onError={() => setFailedSrc(src)}
                />
            ) : (
                <MeIcon className="h-1/2 w-1/2" />
            )}
        </div>
    );
}
