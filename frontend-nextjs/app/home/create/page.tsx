import { redirect } from "next/navigation";

// Parents do not make characters in phase 1: a character prompt is spoken to
// children as written, and nothing moderates one a parent wrote yet. Characters
// are made on the admin page through a server action, and browsers can no
// longer write `personalities` at all (see
// supabase/migrations/20261007140000_personalities_server_writes_only.sql).
//
// The route redirects rather than 404s so an old bookmark still lands
// somewhere. The form itself, app/components/CreateCharacter/, is kept for a
// later, constrained version: pick an admin-made template and change only the
// name, picture and voice.
export default function CreateCharacterPage() {
    redirect("/home");
}
