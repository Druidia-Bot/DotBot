---
name: temp-email
description: Creates a temporary disposable email address for signups, verifications, or receiving one-off emails. Uses mail.tm (free, no API key needed). Includes instructions for checking inbox and cleanup.
tags: [email, temp, disposable, signup, verification, mail.tm]
disable-model-invocation: true
user-invocable: true
allowed-tools: [email.create_temp, email.check_temp_inbox, email.read_temp_message, email.delete_temp, email.list_addresses]
---

# Temp Email — Disposable Address for Signups & Verifications

This skill creates a temporary email address using mail.tm (free, no account or API key needed). Use it when you need to sign up for a service, verify an email address, or receive a one-off message without exposing a real email.

**EXECUTION MODEL: This is an autonomous skill. Create the temp email, use it for the task at hand, check for incoming messages, and clean up when done.**

## Execution Flow

```
1. email.list_addresses({})
   ├─ Temp email already active → use it (skip to step 3)
   └─ No temp email             → continue to step 2
2. email.create_temp({ prefix: "signup" })     ← creates disposable address
3. Use the address for whatever signup/verification is needed
4. email.check_temp_inbox({})                  ← poll for incoming messages
5. email.read_temp_message({ message_id })     ← read the verification email
6. Extract verification code/link from the email body
7. email.delete_temp({})                       ← clean up when done
```

**Do NOT output a plan and stop. Execute the tools.**

---

## Step 1: Check Existing Addresses

```
email.list_addresses({})
```

- **If temp email exists:** Use it — tell the user the address and skip to step 3.
- **If no temp email:** Continue to step 2.

---

## Step 2: Create Temp Email

```
email.create_temp({ prefix: "signup" })
```

Use a descriptive prefix based on what the email is for:
- Signing up for a service: `prefix: "signup"`
- Verifying an account: `prefix: "verify"`
- Receiving a document: `prefix: "receive"`
- Generic/unknown: omit prefix (random name generated)

Tell the user the address:

> I've created a temporary email: **{address}**
>
> This address is active until we delete it. I'll use it for the signup and check for incoming messages.

---

## Step 3: Use the Address

Give the temp email address to whatever service needs it. This might involve:
- Filling out a signup form (via gui tools or instructions to the user)
- Providing the address to an API
- Telling the user to paste it somewhere

---

## Step 4: Check for Messages

After the signup/verification email should have been sent, check the inbox:

```
email.check_temp_inbox({})
```

- **If messages found:** Continue to step 5.
- **If empty:** Wait 15-30 seconds and try again. Emails can take a moment to arrive.
- **After 3 checks with no messages:** Tell the user the email hasn't arrived yet and ask if they want to keep waiting or try again.

**Polling pattern for automated flows:**
1. First check: immediately after signup
2. Second check: wait 15 seconds, then check
3. Third check: wait 30 seconds, then check
4. After that: ask the user

---

## Step 5: Read the Message

```
email.read_temp_message({ message_id: "<id from inbox>" })
```

Look for:
- **Verification codes**: Usually 4-8 digit numbers in the body
- **Verification links**: URLs containing "verify", "confirm", "activate"
- **One-time passwords**: Short alphanumeric codes
- **Welcome messages**: Confirmation that signup succeeded

Extract and present the relevant information to the user or use it to complete the automated flow.

---

## Step 6: Cleanup

When done with the temp email (verification complete, code extracted, etc.):

```
email.delete_temp({})
```

> Temp email deleted. The address is no longer active.

**Always clean up** — don't leave temp emails active indefinitely. They're meant to be short-lived.

---

## Important Notes

- **One temp email at a time** — delete the current one before creating a new one
- **No sending** — temp emails are receive-only
- **Emails are ephemeral** — mail.tm may recycle addresses after a period of inactivity
- **Not for sensitive accounts** — anyone could potentially get the same address later. Use only for throwaway signups
- **Some services block temp email domains** — if a signup rejects the address, tell the user they may need to use a real email for that service

## Troubleshooting

### Service rejects the email domain
Some services block known temp email domains. Tell the user:
> This service doesn't accept temporary email addresses. You'll need to use a personal email for this signup. I can help with the identity email (@getmy.bot) if that's set up — those look like real addresses.

### No messages after multiple checks
The email might have been sent to spam (mail.tm doesn't have a spam folder), or the service might not have sent it. Suggest:
1. Re-request the verification email from the service
2. Check if the address was typed correctly
3. Try creating a new temp email and re-doing the signup

### Token expired
If you get a "session expired" error, delete and recreate:
```
email.delete_temp({})
email.create_temp({ prefix: "retry" })
```
