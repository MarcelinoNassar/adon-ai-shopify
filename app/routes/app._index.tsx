import type {
  HeadersFunction,
  LoaderFunctionArgs,
} from "react-router";
import { authenticate } from "../shopify.server";
import { boundary } from "@shopify/shopify-app-react-router/server";

export const loader = async ({ request }: LoaderFunctionArgs) => {
  await authenticate.admin(request);

  return null;
};

export default function Index() {

  return (
    <div style={{ minHeight: "90vh", display: "flex", justifyContent: "center", alignItems: "center", }}>
      <div style={{ width: 900 }}>
        <s-section>
          <s-text-field label="Enter your API key" placeholder="API key"></s-text-field>
          <s-stack inlineSize="100%">
            <s-button variant="primary" inlineSize="fill">
              Connect Store
            </s-button>
          </s-stack>
        </s-section>
      </div>
    </div>
  );
}

export const headers: HeadersFunction = (headersArgs) => {
  return boundary.headers(headersArgs);
};
