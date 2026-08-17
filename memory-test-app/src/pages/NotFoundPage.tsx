import { Link } from "react-router";
import Button from "../components/ui/Button";

export default function NotFoundPage() {
  return (
    <div className="flex min-h-[50dvh] flex-col items-center justify-center text-center">
      <p className="text-5xl" aria-hidden>
        🗺️
      </p>
      <h1 className="mt-4 text-2xl font-bold text-ink sm:text-3xl">
        Page not found
      </h1>
      <p className="mt-2 max-w-md text-sm text-ink-muted sm:text-base">
        The page you're after doesn't exist. Head back home to keep poking at
        the memory mods.
      </p>
      <Link to="/" className="mt-6">
        <Button>Back to home</Button>
      </Link>
    </div>
  );
}
