import type { ActionFunctionArgs, HeadersFunction, LoaderFunctionArgs } from "react-router";
import { Form, useActionData, useLoaderData } from "react-router";
import { authenticate } from "../shopify.server";
import { boundary } from "@shopify/shopify-app-react-router/server";
import prisma from "../db.server";
import { Text } from "@shopify/polaris";

type ActionData =
  | { error: string; success?: never }
  | { success: true; error?: never };

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { session } = await authenticate.admin(request);

  const store = await prisma.store.findUnique({
    where: { shopDomain: session.shop },
  });

  return { connected: store?.connected ?? false };
};

export const action = async ({ request }: ActionFunctionArgs) => {
  const { session } = await authenticate.admin(request);

  const formData = await request.formData();
  const apiKeyValue = formData.get("apiKey");

  if (typeof apiKeyValue !== "string") {
    return Response.json(
      { error: "API key is required." } satisfies ActionData,
      {
        status: 400,
      },
    );
  }

  const apiKey = apiKeyValue.trim();

  if (!apiKey) {
    return Response.json(
      { error: "API key is required." } satisfies ActionData,
      {
        status: 400,
      },
    );
  }

  const store = await prisma.store.findFirst({
    where: { apiKey },
  });

  if (!store) {
    return Response.json({ error: "Invalid API key." } satisfies ActionData,
      { status: 401 },
    );
  }

  if (!session.shop) {
    return Response.json(
      { error: "No shop domain found for this session." } satisfies ActionData,
      { status: 400 },
    );
  }

  if (!session.accessToken) {
    return Response.json(
      { error: "No access token for this session." } satisfies ActionData,
      { status: 400 },
    );
  }

  await prisma.store.update({
    where: { id: store.id },
    data: {
      shopDomain: session.shop,
      accessToken: session.accessToken,
      connected: true,
    },
  });

  return Response.json({ success: true } satisfies ActionData);
};

export default function Index() {
  const { connected } = useLoaderData<typeof loader>();
  const actionData = useActionData<ActionData>();

  const isConnected = connected || actionData?.success === true;

  return (
    <div style={{ minHeight: "90vh", display: "flex", justifyContent: "center", alignItems: "center" }}>
      <div style={{ width: 900 }}>

        {isConnected ? (
          <div style={{ display: "flex", justifyContent: "center", alignItems: "center" }}>
            <Text as="p">Store connected successfully.</Text>
          </div>
        ) : (

          <Form method="post">
            <s-section>
              <s-text-field
                name="apiKey"
                label="Enter your API key"
                placeholder="API key"
                required
                error={actionData && "error" in actionData ? actionData.error : undefined}
              />

              <s-button type="submit" inlineSize="fill" variant="primary">
                Connect Store
              </s-button>
            </s-section>
          </Form>
        )}
      </div>
    </div>
  );
}

export const headers: HeadersFunction = (headersArgs) => {
  return boundary.headers(headersArgs);
};
