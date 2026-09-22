import { SkeletonCard } from "../HomeSkeleton";

// /home/create still renders inside the old sidebar shell, so it gets a plain
// card rather than the full-page frame the other three use.
export default function Loading() {
    return (
        <div className="flex flex-col gap-2 pb-4">
            <SkeletonCard className="bg-white" />
        </div>
    );
}
