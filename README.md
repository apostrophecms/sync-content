[![CircleCI](https://circleci.com/gh/apostrophecms/sync-content/tree/master.svg?style=svg)](https://circleci.com/gh/apostrophecms/sync-content/tree/master)
[![Chat on Discord](https://img.shields.io/discord/517772094482677790.svg)](https://chat.apostrophecms.org)

<p align="center">
  <a href="https://github.com/apostrophecms/apostrophe">
    <!-- TODO:  -->
    <img src="https://raw.githubusercontent.com/apostrophecms/apostrophe/main/logo.svg" alt="ApostropheCMS logo" width="80" height="80">
  </a>

  <h1 align="center">Sync Content for ApostropheCMS</h1>
</p>

The Sync Content module allows syncing ApostropheCMS site content between different server environments, without the need for direct access to remote databases, directories, S3 buckets, etc.

**Status:** In development (not for production use)

## Purpose

### What it does

This module is useful when migrating content between development, staging and production environments without direct access to the underlying database and media storage. It is also useful when migrating between projects, however bear in mind that the new project must have the same doc and widget types available with the same fields in order to function properly.

## Installation

To install the module, use the command line to run this command in an Apostrophe project's root directory:

```
npm install @apostrophecms/sync-content
```

## Usage

Configure the `@apostrophecms/sync-content` module in the `app.js` file:

```javascript
require('apostrophe')({
  shortName: 'my-project',
  modules: {
    '@apostrophecms/sync-content': {
      // Our API key, for incoming sync requests
      apiKey: 'choose-a-very-secure-random-key',
      environments: {
        staging: {
          label: 'Staging',
          url: 'https://mysite.staging.mycompany.com',
          // Their API key, for outgoing sync requests
          apiKey: 'choose-a-very-secure-random-key'  
        }
      }
    }
  }
});
```

### Syncing via the user interface

#### Syncing the entire site

Click the "Sync" button in the admin bar to sync the entire site's content to or from another environment. You will be asked which environment you want to sync with, and whether documents existing only in the destination environment should be kept or discarded. The sync operation may take a long time, partly due to the need to sync media files, such as images.

#### Syncing a selection of pieces

You can also sync a selection of pieces. In the "Manage" view of any piece type (except users and groups), first make a selection of as many pieces as you wish. Then click "Sync."

You will be given the option to include related documents, i.e. images and other documents directly selected via a widget or field of the piece. To prevent unexpected outcomes, pages are never synced as related documents.

### Syncing via command line tasks

```bash
# sync all content FROM this site, TO another environment.
# If other content already exists, purge it
node app @apostrophecms/sync-content:sync --to=staging
# sync all content TO this site, FROM another environment.
# If other content already exists locally, purge it
node app @apostrophecms/sync-content:sync --from=staging
# sync content of one piece type only, plus any related
# documents. If other content already exists locally, purge it
node app @apostrophecms/sync-content:sync --from=staging --type=articles
# Same, but keep other content of this type
node app @apostrophecms/sync-content:sync --from=staging --type=articles --keep
# sync content of one piece type only, without related documents
# (may also be combined with --keep)
node app @apostrophecms/sync-content:sync --from=staging --type=articles --without-related
# skip media, for speed (you will see broken images)
node app @apostrophecms/sync-content:sync --from=staging --skip-media
```

* You must specify either `--from` or `--to` to specify the environment to sync with, as seen in your configuration above, where `staging` is an example.
* You may specify `--type=typename` to specify one content type only. This must be a piece type, and must match the `name` option of the type (**not** the module name, unless they are the same).
* When using `--type`, you may also specify `--keep` to keep preexisting pieces whose `_id` does not appear in the synced content. **For data integrity reasons, this is not available when syncing an entire site.**
* By default, syncing a piece type will also sync directly related documents, such as images found in that piece. If you do not want this, specify `--without-related`.
* Actual media files, i.e. images, PDFs, etc., are always synced when using the UI. However on the command line you can skip this with `--skip-media`. **This will definitely result in broken images,** but is useful for quick tests.

### Security restrictions

For security reasons, and to avoid chicken and egg problems when using the UI, users and groups are **not** synced. You will have the same users and groups as before the sync operation.

To prevent unexpected outcomes, only admins can access the Sync button.

### Additional notes

Syncing a site takes time, especially if the site has media. Get a cup of coffee.
