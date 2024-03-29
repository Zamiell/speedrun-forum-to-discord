import type { GaxiosResponse } from "gaxios";
import type { OAuth2Client } from "google-auth-library";
import type { gmail_v1 } from "googleapis";
import { google } from "googleapis";
import {
  decodeBase64,
  fatalError,
  isFile,
  readFile,
} from "isaacscript-common-node";
import {
  HOUR_IN_MILLISECONDS,
  assertDefined,
  assertNotNull,
  isObject,
  parseIntSafe,
} from "isaacscript-common-ts";
import path from "node:path";
import { REPO_ROOT } from "./constants.js";
import { discordSend } from "./discord.js";
import { logger } from "./logger.js";

const SPEEDRUN_DOT_COM_EMAIL_FROM_HEADER =
  '"Speedrun.com" <noreply@speedrun.com>';
const NOTIFICATION_LINE = "<p>You have a new notification:</p>";

/**
 * e.g. <p><strong><a href="https://www.speedrun.com/repentance/thread/9mvqg">teh_supar_hackr posted
 * a new thread in the The Binding of Isaac: Repentance forum: Online Multiplayer and
 * Deadgod%</a></strong></p>
 */
const LINK_REGEX = /<a href="(.+)">(.+)<\/a>/;

const TOKEN_PATH = path.join(REPO_ROOT, "token.json");

let gmailClient: gmail_v1.Gmail | undefined;
const processedEmailIDs = new Set<string>();

export function gmailInit(): void {
  const oAuth2Client = getOAuth2Client();
  gmailClient = google.gmail({ version: "v1", auth: oAuth2Client });
}

function getOAuth2Client(): OAuth2Client | undefined {
  if (!isFile(TOKEN_PATH)) {
    fatalError(
      `The "${TOKEN_PATH}" file does not exist. Follow the steps in the README to create it.`,
    );
  }

  const tokenContent = readFile(TOKEN_PATH);
  const token = JSON.parse(tokenContent) as unknown;
  if (!isObject(token)) {
    throw new Error(
      `Failed to parse the "${TOKEN_PATH}" file since it was not an object.`,
    );
  }

  return google.auth.fromJSON(token) as OAuth2Client;
}

export async function checkNewEmails(): Promise<void> {
  logger.info("Checking for new emails...");

  if (gmailClient === undefined) {
    throw new Error(
      "Failed to check for new emails since the Gmail client was not initialized.",
    );
  }

  try {
    const listMessagesResponse = await gmailClient.users.messages.list({
      userId: "me",
      maxResults: 10,
    });

    assertDefined(
      listMessagesResponse.data.messages,
      "Failed to get the messages from the list messages response.",
    );

    const now = Date.now();
    const oneHourAgo = now - HOUR_IN_MILLISECONDS;

    for (const schemaMessage of listMessagesResponse.data.messages) {
      const { id } = schemaMessage;

      if (typeof id !== "string") {
        throw new TypeError(
          "Failed to parse the id of a list messages response.",
        );
      }

      if (!processedEmailIDs.has(id)) {
        processedEmailIDs.add(id);

        // eslint-disable-next-line no-await-in-loop
        await processNewEmailID(gmailClient, id, oneHourAgo);
      }
    }
  } catch (error) {
    console.error("Failed to check new emails:", error);
  }
}

async function processNewEmailID(
  client: gmail_v1.Gmail,
  id: string,
  timeThreshold: number,
) {
  logger.info(`Processing new email with ID: ${id}`);

  const message = await client.users.messages.get({
    userId: "me",
    id,
  });

  const { internalDate } = message.data;
  if (typeof internalDate !== "string") {
    throw new TypeError(
      `Failed to parse the "internalDate" of an email message data corresponding to id: ${id}`,
    );
  }

  const internalDateNumber = parseIntSafe(internalDate);
  assertDefined(
    internalDateNumber,
    `Failed to convert the "internalDate" of email message "${id}" to a number: ${internalDate}`,
  );

  if (internalDateNumber < timeThreshold) {
    return;
  }

  const senderAddress = getMessageSenderAddress(message);
  assertDefined(
    senderAddress,
    `Failed to get the message sender address of an email message corresponding to id: ${id}`,
  );

  if (senderAddress !== SPEEDRUN_DOT_COM_EMAIL_FROM_HEADER) {
    return;
  }

  const { payload } = message.data;
  assertDefined(
    payload,
    `Failed to get the payload of an email message corresponding to id: ${id}`,
  );

  const { body } = payload;
  assertDefined(
    body,
    `Failed to get the body of an email message corresponding to id: ${id}`,
  );

  const { data } = body;
  if (typeof data !== "string") {
    throw new TypeError(
      `Failed to get the data of an email message corresponding to id: ${id}`,
    );
  }

  const emailContents = decodeBase64(data);
  if (emailContents === "") {
    throw new TypeError(
      `Failed to decode the data of an email message corresponding to id: ${id}`,
    );
  }

  await announceSpeedrunComEmail(id, emailContents);
}

function getMessageSenderAddress(
  message: GaxiosResponse<gmail_v1.Schema$Message>,
): string | undefined {
  const { payload } = message.data;
  if (payload === undefined) {
    return undefined;
  }

  const { headers } = payload;
  if (headers === undefined) {
    return undefined;
  }

  const fromHeader = headers.find((header) => header.name === "From");
  if (fromHeader === undefined) {
    return undefined;
  }

  const { value } = fromHeader;
  if (typeof value !== "string") {
    return undefined;
  }

  return value;
}

// For reference, the following is an example of the HTML content of an email from Speedrun.com:

// cspell:ignore supar hackr Deadgod Roboto

/*

<!DOCTYPE html>
<html>
  <head>
    <title>teh_supar_hackr posted a new thread in the The Binding of Isaac: Repentance forum: Online Multiplayer and Deadgod%</title>
  </head>
  <body style="color: #303030; background: #e0e0e0; padding: 8px">
    <p align="left">
      <img src="https://www.speedrun.com/images/logo-black.png" alt="Speedrun.com" width="180" style="display: block; width: 180px; height: auto" />
    </p>
    <p>
      <span style="font-family: -apple-system, BlinkMacSystemFont, Roboto, Helvetica, Arial, sans-serif; font-size: 16px;">
        <p>Hi IsaacBot,</p>
        <p>You have a new notification:</p>
        <p><strong><a href="https://www.speedrun.com/repentance/thread/9mvqg">teh_supar_hackr posted a new thread in the The Binding of Isaac: Repentance forum: Online Multiplayer and Deadgod%</a></strong></p>
        <p>You are receiving this email because you have emails enabled in your <a href="https://www.speedrun.com/user/IsaacBot/settings">notification settings</a>.</p>
        <p>Please contact support at <a href="mailto:support@speedrun.com">support@speedrun.com</a> if you need help.</p>
      </span>
    </p>
    <p>&nbsp;</p>
    <p>
      <br />
      <span style="font-family: -apple-system, BlinkMacSystemFont, Roboto, Helvetica, Arial, sans-serif; font-size: 12px">
        To change your email preferences, please visit your <a href="https://www.speedrun.com/settings">settings page</a>.
      </span>
    </p>
  </body>
</html>

*/

async function announceSpeedrunComEmail(id: string, emailContents: string) {
  const lines = emailContents.split("\n");
  const lineNumber = getLineNumberThatIncludes(lines, NOTIFICATION_LINE);
  assertDefined(
    lineNumber,
    `Failed to get the line number of the notification in the email corresponding to id: ${id}`,
  );

  const nextLineNumber = lineNumber + 1;
  const line = lines[nextLineNumber];
  assertDefined(
    line,
    `Failed to get line ${nextLineNumber} of the email corresponding to id: ${id}`,
  );

  const match = LINK_REGEX.exec(line);
  assertNotNull(
    match,
    `Failed to parse the line "${line}" of the email corresponding to id: ${id}`,
  );

  const [_, link, text] = match;
  assertDefined(
    link,
    `Failed to parse the link of the email corresponding to id: ${id}`,
  );
  assertDefined(
    text,
    `Failed to parse the text of the email corresponding to id: ${id}`,
  );

  const msg = `[${text}](${link})`;
  await discordSend(msg);
}

function getLineNumberThatIncludes(
  lines: readonly string[],
  matchingText: string,
): number | undefined {
  for (const [i, line] of lines.entries()) {
    if (line.includes(matchingText)) {
      return i;
    }
  }

  return undefined;
}
