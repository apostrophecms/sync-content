# apostrophe-backup

Backup and restore utility for Apostrophe sites.

This tool is useful when migrating content between development, staging and production environments without direct access to the underlying database and media storage. It is also useful when migrating between projects, however bear in mind that the new project must have the same doc and widget types available with the same fields in order to function properly.

## User Interface

The Download Backup and Restore Backup buttons are available via the admin bar, on the Backups menu.

**Restoring a backup completely overwrites the content of the site and cannot be undone.**

## Command line task

This module can also be used via the following command line tasks:

```
# Creates filename.zip
node app apostrophe-backup:backup filename.zip

# Restores filename.zip
node app apostrophe-backup:restore filename.zip
```

## Notes

Backups can be quite large as they include media files.
