# Cookie Import

Testing a site you are already logged into usually means logging in again in
the Lanius browser. **Settings > Browser > Import cookies** copies the cookies
from a browser profile you already use into the Lanius browser profile
instead, so the session carries over.

Everything happens on this computer. Lanius never shows cookie values in the
interface, an API response, or a log; it reports counts only.

## Two ways to import

| | Direct import | Browser extension |
|---|---|---|
| Use when | Lanius can read the source profile | The source browser protects its cookies, such as Chrome on Windows |
| Sources | Chrome, Chrome Beta, Chromium, Firefox | Any Chromium browser that can load an unpacked extension |
| What you install | Nothing | A small Lanius extension, removed afterwards |

Both write into the same destination: the profile of the Lanius browser you
pick as **Destination browser** (Chrome, Chrome Beta, Chromium, or Firefox).

## Before you start

- Open the destination browser from Lanius once, then close it. That creates
  the Lanius profile the cookies are written into.
- Quit the Lanius destination browser while importing. Lanius refuses to write
  into a profile that is in use. On macOS, closing its windows leaves the
  browser running; press Cmd+Q in it. Settings notices when it has quit.
- If you chose a custom browser data folder in **Settings > Browser**, cookies
  go into that folder's profile.

## Direct import

1. Choose the **Destination browser**.
2. Choose the **Source profile**. The list shows each Chrome, Chrome Beta,
   Chromium, and Firefox profile found in its standard location, with its
   cookie count. Use **Refresh** after creating or closing a profile.
3. Click **Import cookies** and confirm.

Your operating system may ask for permission first. Chromium browsers encrypt
their cookies with a key kept by the OS:

- **macOS:** Keychain asks whether Lanius may read the browser's "Safe Storage"
  key. Choose **Allow** for a single import.
- **Linux:** the key comes from the desktop keyring through `secret-tool`
  (package `libsecret-tools`). The keyring has to be unlocked.
- **Windows:** the key is protected for your user account. Recent Chrome
  versions also bind cookies to Chrome itself; those cookies are counted as
  *protected* and skipped. Use the extension for them.

Firefox profiles are not encrypted and need no permission.

## Import with the browser extension

Use the extension when direct import reports protected cookies or does not
list your browser. **Install it in the browser you normally use, the one that
holds the cookies, not in the Lanius browser.**

1. In Lanius, click **Download Lanius extension** and save
   `lanius-cookie-transfer.zip`. Unzip it.
2. In your normal browser, open `chrome://extensions` (`edge://extensions` in
   Edge, `brave://extensions` in Brave), turn on **Developer mode**, choose
   **Load unpacked**, and select the unzipped folder.
3. Back in Lanius, choose the **Destination browser** and click
   **Get one-time code**.
4. In your normal browser, click the **Lanius Cookie Transfer** icon in the
   toolbar (it may be under the puzzle-piece menu), paste the code, and click
   **Send cookies**. The code is valid for 5 minutes and works once.
5. Lanius shows the result. Remove the extension from `chrome://extensions`
   when you are finished.

The extension reads the cookies of the browser profile it is installed in and
sends them only to Lanius on `127.0.0.1`. It contacts no other server, and
Lanius accepts the transfer only with the code shown in its own window.

## What is imported

- Partitioned cookies (CHIPS) are skipped, because they belong to one embedding
  site and cannot be placed correctly in another profile.
- Expired cookies are skipped.
- Session-only cookies would disappear when the Lanius browser closes, so they
  are given an expiry 8 hours ahead.
- A cookie with the same site, name, and path as one already in the Lanius
  profile replaces it.

After an import Lanius reports how many cookies were imported and how many
were skipped as partitioned, expired, unsupported, or protected.

Some sites keep part of a login in local storage or tie a session to the
original device. Those sites may still ask you to log in again.

## Troubleshooting

- **Nothing in Source profile:** no supported profile was found in its standard
  location. Use the extension instead.
- **Quit the Lanius destination browser:** the Lanius browser is still
  running. On macOS it keeps running after its last window closes, so press
  Cmd+Q in it. The buttons become available within a few seconds.
- **Open the destination browser from Lanius once:** the Lanius profile does not
  exist yet.
- **Keychain or keyring errors:** the OS refused access to the browser key, or
  the keyring is locked. Unlock it and try again, or use the extension.
- **The code expired:** get a new code and enter it within 5 minutes.
- **The extension says the transfer failed:** check that Lanius is still
  running and that the code was copied in full.
