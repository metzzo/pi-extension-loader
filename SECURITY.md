# Security policy

## Supported versions

Security fixes are provided for the latest published version.

## Reporting a vulnerability

Do not include exploit details, credentials, or other sensitive information in a public issue.

Use GitHub's private vulnerability-reporting feature for this repository. If it is unavailable, contact the maintainer listed on the npm package page and request a private reporting channel.

Include the affected package version, Pi and Node.js versions, operating system, impact, and minimal reproduction steps. Allow time for investigation before public disclosure.

## Security model

Pi extensions execute with the user's full filesystem and process permissions. Review the source before installing any extension.

This extension itself performs no direct filesystem, process, or network operations. It registers a command and tool, then asks Pi to run its native resource reload. A reload executes every configured extension again, so the security of the result also depends on the other Pi resources the user has installed.

The opt-in end-to-end development test copies local Pi authentication files to a temporary agent directory and makes one live Luna request. It removes the temporary directory when finished and does not include credentials in its RPC evidence logs.
