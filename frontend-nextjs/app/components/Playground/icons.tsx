import { useId } from "react";

// Vector versions of the PNGs that used to live in /asset/icons, traced at the same
// size and colors so they drop into the same boxes. Size them with className.

type IconProps = { className?: string };

// useId returns ":r0:" on React 18; colons are unsafe inside url(#...).
function useSvgId() {
    return useId().replace(/:/g, "");
}

function BlueDisc({ id }: { id: string }) {
    return (
        <>
            <defs>
                <linearGradient id={id} x1="0" y1="0" x2="1" y2="1">
                    <stop offset="0.5" stopColor="#1F6FE6" />
                    <stop offset="1" stopColor="#123D82" />
                </linearGradient>
            </defs>
            <circle cx="32" cy="32" r="32" fill={`url(#${id})`} />
        </>
    );
}

function IndigoDisc({ id, size }: { id: string; size: number }) {
    const r = size / 2;
    return (
        <>
            <defs>
                <linearGradient id={id} x1="0" y1="0" x2="0" y2="1">
                    <stop offset="0" stopColor="#6969FB" />
                    <stop offset="1" stopColor="#40409B" />
                </linearGradient>
            </defs>
            <circle cx={r} cy={r} r={r} fill={`url(#${id})`} />
        </>
    );
}

export function MicIcon({ className }: IconProps) {
    const id = useSvgId();
    return (
        <svg viewBox="0 0 112 112" className={className} aria-hidden="true">
            <IndigoDisc id={id} size={112} />
            <g fill="none" stroke="#fff" strokeWidth="6" strokeLinecap="round" strokeLinejoin="round">
                <rect x="48" y="29" width="16" height="33" rx="8" />
                <path d="M38 51v1a18 18 0 0 0 36 0v-1" />
                <path d="M56 73v11M46 85h20" />
            </g>
        </svg>
    );
}

export function CheckIcon({ className }: IconProps) {
    const id = useSvgId();
    return (
        <svg viewBox="0 0 32 32" className={className} aria-hidden="true">
            <IndigoDisc id={id} size={32} />
            <path
                d="M11 15.5l3.5 3.5 7-7"
                fill="none"
                stroke="#fff"
                strokeWidth="4"
                strokeLinecap="round"
                strokeLinejoin="round"
            />
        </svg>
    );
}

export function BackIcon({ className }: IconProps) {
    const id = useSvgId();
    return (
        <svg viewBox="0 0 64 64" className={className} aria-hidden="true">
            <BlueDisc id={id} />
            <path
                d="M35 24l-7.5 7.5 7.5 7.5"
                fill="none"
                stroke="#fff"
                strokeWidth="10"
                strokeLinecap="round"
                strokeLinejoin="round"
            />
        </svg>
    );
}

export function PlusIcon({ className }: IconProps) {
    const id = useSvgId();
    return (
        <svg viewBox="0 0 64 64" className={className} aria-hidden="true">
            <BlueDisc id={id} />
            <path d="M31.5 23v17M23 31.5h17" fill="none" stroke="#fff" strokeWidth="10" strokeLinecap="round" />
        </svg>
    );
}

export function CloseIcon({ className }: IconProps) {
    const id = useSvgId();
    return (
        <svg viewBox="0 0 96 96" className={className} aria-hidden="true">
            <defs>
                <linearGradient id={id} x1="0" y1="0" x2="0" y2="1">
                    <stop offset="0" stopColor="#F5E6E6" />
                    <stop offset="0.6" stopColor="#DAEEF5" />
                    <stop offset="1" stopColor="#D5EEF0" />
                </linearGradient>
            </defs>
            <circle cx="48" cy="48" r="48" fill={`url(#${id})`} fillOpacity="0.4" />
            <path d="M41 41l14 14M55 41L41 55" fill="none" stroke="#404099" strokeWidth="9" strokeLinecap="round" />
        </svg>
    );
}

export function ChevronDownIcon({ className }: IconProps) {
    return (
        <svg viewBox="0 0 40 40" className={className} aria-hidden="true">
            <path
                d="M10 15l10 10 10-10"
                fill="none"
                stroke="#AEAEB2"
                strokeWidth="4"
                strokeLinecap="round"
                strokeLinejoin="round"
            />
        </svg>
    );
}

export function CharactersIcon({ className }: IconProps) {
    return (
        <svg viewBox="0 0 64 64" className={className} fill="#E95C5E" aria-hidden="true">
            <circle cx="24" cy="18" r="13.75" />
            <path d="M0 55.5V47A11 10 0 0 1 11 37h26a11 10 0 0 1 11 10v8.5a3 3 0 0 1-3 3H3a3 3 0 0 1-3-3z" />
            <path
                d="M43 8a10.25 10.25 0 0 1 0 20M53.5 41c4.5 2.5 7.5 6.5 7.5 12v3"
                fill="none"
                stroke="#E95C5E"
                strokeWidth="6"
                strokeLinecap="round"
            />
        </svg>
    );
}

const GEAR_TEETH = [0, 45, 90, 135, 180, 225, 270, 315];

export function SettingsIcon({ className }: IconProps) {
    return (
        <svg viewBox="0 0 64 64" className={className} aria-hidden="true">
            <g fill="#FAC04F" transform="translate(32 32)">
                <circle r="22" />
                {GEAR_TEETH.map((angle) => (
                    <rect key={angle} x="-5" y="-29" width="10" height="16" rx="4" transform={`rotate(${angle})`} />
                ))}
            </g>
            <circle cx="32" cy="32" r="8" fill="#fff" />
        </svg>
    );
}

// 3x3 star grid, simplified like the original 36px artwork.
const US_FLAG_STARS =
    "M4.5 1.3L5.06 2.83L6.69 2.89L5.4 3.89L5.85 5.46L4.5 4.55L3.15 5.46L3.6 3.89L2.31 2.89L3.94 2.83Z" +
    "M9.5 1.3L10.06 2.83L11.69 2.89L10.4 3.89L10.85 5.46L9.5 4.55L8.15 5.46L8.6 3.89L7.31 2.89L8.94 2.83Z" +
    "M14.5 1.3L15.06 2.83L16.69 2.89L15.4 3.89L15.85 5.46L14.5 4.55L13.15 5.46L13.6 3.89L12.31 2.89L13.94 2.83Z" +
    "M4.5 6.7L5.06 8.23L6.69 8.29L5.4 9.29L5.85 10.86L4.5 9.95L3.15 10.86L3.6 9.29L2.31 8.29L3.94 8.23Z" +
    "M9.5 6.7L10.06 8.23L11.69 8.29L10.4 9.29L10.85 10.86L9.5 9.95L8.15 10.86L8.6 9.29L7.31 8.29L8.94 8.23Z" +
    "M14.5 6.7L15.06 8.23L16.69 8.29L15.4 9.29L15.85 10.86L14.5 9.95L13.15 10.86L13.6 9.29L12.31 8.29L13.94 8.23Z" +
    "M4.5 12.1L5.06 13.63L6.69 13.69L5.4 14.69L5.85 16.26L4.5 15.35L3.15 16.26L3.6 14.69L2.31 13.69L3.94 13.63Z" +
    "M9.5 12.1L10.06 13.63L11.69 13.69L10.4 14.69L10.85 16.26L9.5 15.35L8.15 16.26L8.6 14.69L7.31 13.69L8.94 13.63Z" +
    "M14.5 12.1L15.06 13.63L16.69 13.69L15.4 14.69L15.85 16.26L14.5 15.35L13.15 16.26L13.6 14.69L12.31 13.69L13.94 13.63Z";

export function UsFlagIcon({ className }: IconProps) {
    const id = useSvgId();
    return (
        <svg viewBox="0 0 36 36" className={className} aria-hidden="true">
            <defs>
                <clipPath id={id}>
                    <circle cx="18" cy="18" r="18" />
                </clipPath>
            </defs>
            <g clipPath={`url(#${id})`}>
                <rect width="36" height="36" fill="#F0F0F0" />
                <path d="M0 4.5h36v4.5H0zM0 13.5h36V18H0zM0 22.5h36V27H0zM0 31.5h36V36H0z" fill="#D80027" />
                <rect width="18" height="18" fill="#0052B4" />
                <path fill="#F0F0F0" d={US_FLAG_STARS} />
            </g>
        </svg>
    );
}
