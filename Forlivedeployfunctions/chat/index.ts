export const onRequest: PagesFunction = async () => {
  return Response.json({ ok: true, route: "/chat" });
};
