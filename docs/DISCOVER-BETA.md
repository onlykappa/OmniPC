# Discover beta

Install the Windows beta, then open **Discover** in the sidebar.

Choose **Load Overdrive catalog** to fetch and verify the official Overdrive v0.2.2 release. Alternatively, choose **Import release ZIP** and select the original official ZIP. The importer reads metadata without executing console binaries. It recovers 2,074 PS4 and PS5 catalog entries, including available covers, descriptions and grouped sources. Catalog data and download history stay in your local Data/Discover folder.

Search or filter the catalog and open a game to inspect its editions and sources. Single files marked as direct support downloading. Browser-only and multipart sources require manual host steps. Single unprotected ZIP/7z downloads support safe extraction and the normal library scan. Other formats require preparation with suitable tools, followed by **Add game folder**. Catalog entries become playable only when the local library finds compatible game files and an appropriate emulator is configured. PS5 listings do not imply PS5 emulator compatibility.

This beta disables public-channel self-updates. Its GitHub workflow uploads the installer and portable ZIP exclusively to an unpublished draft release, without public Actions artifacts. Drafts are visible to repository writers; the source branch remains public because the repository is public. Publishing a prerelease would make it public.

Validation: type checking, production build and targeted importer/download tests pass. The full suite is also required on the Windows beta runner before upload. The restricted development host could not run existing network-share integration tests because network interface enumeration is unavailable.
