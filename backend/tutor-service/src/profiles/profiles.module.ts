import { Module } from '@nestjs/common';
import { FILE_STORAGES, RtdbFileStorage } from '../files/file-storage';
import { FilesService } from '../files/files.service';
import { LocationsController } from '../locations/locations';
import { MyProfileController, ReviewController } from './profiles.controller';
import { ProfilesService } from './profiles.service';

@Module({
  // LocationsController first: its literal paths must win over `tutors/:id`.
  controllers: [LocationsController, MyProfileController, ReviewController],
  providers: [
    ProfilesService,
    FilesService,
    // Newest first: new files go to the first one. Add an S3 storage here to move on (docs/07 §5).
    { provide: FILE_STORAGES, useFactory: () => [RtdbFileStorage.fromEnv()].filter(Boolean) },
  ],
})
export class ProfilesModule {}
