import { redirect } from "next/navigation";

// Moved to Me > Personal Info > Change password; this keeps the old address
// working.
export default function ResetPassword() {
    redirect("/home/account/password");
}
