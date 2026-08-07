"use strict";

function persistGeneratedIdentity(options) {
  const currentProfiles = options.readProfiles();
  const index = currentProfiles.findIndex((profile) => profile.id === options.id);
  if (index < 0) throw new Error("Profile đã bị xóa trong lúc tạo identity.");
  const current = currentProfiles[index];
  if (current.automaticIdentity) throw new Error("Profile đã có identity; vui lòng mở lại.");
  if (!options.sameGenerationConfig(options.expectedProfile, current)) {
    throw new Error("Cấu hình profile đã thay đổi trong lúc tạo identity; vui lòng thử lại.");
  }

  const launchProfile = {
    ...current,
    proxyPublicIp: options.identityResult.ip,
    automaticIdentity: options.identityResult.identity,
  };
  const nextProfiles = [...currentProfiles];
  nextProfiles[index] = launchProfile;
  const previousRegistry = options.readRegistry();
  options.writeProfiles(nextProfiles);
  try {
    options.ensureProfileData(launchProfile);
  } catch (error) {
    try {
      options.restoreRegistry(previousRegistry);
    } catch (rollbackError) {
      throw new AggregateError([error, rollbackError], "Không thể ghi metadata identity và rollback registry thất bại.");
    }
    throw error;
  }
  return { launchProfile, profiles: nextProfiles };
}

module.exports = { persistGeneratedIdentity };
