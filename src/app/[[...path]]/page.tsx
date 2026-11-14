import { notFound } from "next/navigation";
export default async function Page({
  params,
}: {
  params: Promise<{ path?: string[] }>;
}) {
  const { path = [] } = await params;
  if (
    path.length === 0 ||
    (path.length === 1 &&
      ["activity", "networks", "help", "about", "settings"].includes(
        path[0],
      )) ||
    (path.length === 2 &&
      path[0] === "activity" &&
      /^[a-zA-Z0-9-]{1,80}$/.test(path[1]))
  )
    return null;
  notFound();
}
