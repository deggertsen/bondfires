# Welcome to your Convex functions directory!

Write your Convex functions here.
See https://docs.convex.dev/functions for more.

A query function that takes two arguments looks like:

```ts
// convex/myFunctions.ts
import { query } from "./_generated/server";
import { v } from "convex/values";

export const myQueryFunction = query({
  // Validators for arguments.
  args: {
    first: v.number(),
    second: v.string(),
  },

  // Function implementation.
  handler: async (ctx, args) => {
    // Read the database as many times as you need here.
    // See https://docs.convex.dev/database/reading-data.
    const documents = await ctx.db.query("tablename").collect();

    // Arguments passed from the client are properties of the args object.
    console.log(args.first, args.second);

    // Write arbitrary JavaScript here: filter, aggregate, build derived data,
    // remove non-public properties, or create new objects.
    return documents;
  },
});
```

Using this query function in a React component looks like:

```ts
const data = useQuery(api.myFunctions.myQueryFunction, {
  first: 10,
  second: "hello",
});
```

A mutation function looks like:

```ts
// convex/myFunctions.ts
import { mutation } from "./_generated/server";
import { v } from "convex/values";

export const myMutationFunction = mutation({
  // Validators for arguments.
  args: {
    first: v.string(),
    second: v.string(),
  },

  // Function implementation.
  handler: async (ctx, args) => {
    // Insert or modify documents in the database here.
    // Mutations can also read from the database like queries.
    // See https://docs.convex.dev/database/writing-data.
    const message = { body: args.first, author: args.second };
    const id = await ctx.db.insert("messages", message);

    // Optionally, return a value from your mutation.
    return await ctx.db.get("messages", id);
  },
});
```

Using this mutation function in a React component looks like:

```ts
const mutation = useMutation(api.myFunctions.myMutationFunction);
function handleButtonPress() {
  // fire and forget, the most common way to use mutations
  mutation({ first: "Hello!", second: "me" });
  // OR
  // use the result once the mutation has completed
  mutation({ first: "Hello!", second: "me" }).then((result) =>
    console.log(result),
  );
}
```

Use the Convex CLI to push your functions to a deployment. See everything
the Convex CLI can do by running `npx convex -h` in your project root
directory. To learn more, launch the docs with `npx convex docs`.

---

## Admin: Reviewer Account Management

For Google Play and App Store reviews, you'll need to provide test credentials
that bypass email verification. Use the `reviewerAccounts` mutations to manage
these accounts.

### Setup a Reviewer Account

1. **Create the account** via the app's normal signup flow with an email like
   `googlereview@bondfires.org`

2. **Mark it as a reviewer account** (bypasses email verification):

```bash
npx convex run reviewerAccounts:setupReviewerAccount '{"email": "googlereview@bondfires.org"}'
```

3. **Provide the credentials** to the app store:
   - Email: `googlereview@bondfires.org`
   - Password: (whatever was used during signup)

### List All Reviewer Accounts

```bash
npx convex run reviewerAccounts:listReviewerAccounts
```

### Revoke Reviewer Access

Removes the reviewer flag but keeps the account:

```bash
npx convex run reviewerAccounts:revokeReviewerAccess '{"email": "googlereview@bondfires.org"}'
```

### Delete a Reviewer Account

Permanently deletes the account and all associated data:

```bash
npx convex run reviewerAccounts:deleteReviewerAccount '{"email": "googlereview@bondfires.org", "confirmDelete": true}'
```
