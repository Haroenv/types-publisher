import { Logger } from "../util/logging";
import { assertDefined, best, intOfString } from "../util/util";

import { readDataFile } from "./common";
import { CachedNpmInfoClient } from "./npm-client";
import { AllPackages, NotNeededPackage, PackageId, TypingsData } from "./packages";

export const versionsFilename = "versions.json";

export interface ChangedTyping {
    readonly pkg: TypingsData;
    /** This is the version to be published, meaning it's the version that doesn't exist yet. */
    readonly version: string;
    /** For a non-latest version, this is the latest version; publishing an old version updates the 'latest' tag and we want to change it back. */
    readonly latestVersion: string | undefined;
}

export interface ChangedPackagesJson {
    readonly changedTypings: ReadonlyArray<ChangedTypingJson>;
    readonly changedNotNeededPackages: ReadonlyArray<string>;
}

export interface ChangedTypingJson {
    readonly id: PackageId;
    readonly version: string;
    readonly latestVersion?: string;
}

export interface ChangedPackages {
    readonly changedTypings: ReadonlyArray<ChangedTyping>;
    readonly changedNotNeededPackages: ReadonlyArray<NotNeededPackage>;
}

export async function readChangedPackages(allPackages: AllPackages): Promise<ChangedPackages> {
    const json = await readDataFile("calculate-versions", versionsFilename) as ChangedPackagesJson;
    return {
        changedTypings: json.changedTypings.map(({ id, version, latestVersion }): ChangedTyping =>
            ({ pkg: allPackages.getTypingsData(id), version, latestVersion })),
        changedNotNeededPackages: json.changedNotNeededPackages.map(id => assertDefined(allPackages.getNotNeededPackage(id))),
    };
}

/**
 * When we fail to publish a deprecated package, it leaves behind an entry in the time property.
 * So the keys of 'time' give the actual 'latest'.
 * If that's not equal to the expected latest, try again by bumping the patch version of the last attempt by 1.
 */
export function skipBadPublishes(pkg: NotNeededPackage, client: CachedNpmInfoClient, log: Logger) {
    // because this is called right after isAlreadyDeprecated, we can rely on the cache being up-to-date
    const info = assertDefined(client.getNpmInfoFromCache(pkg.fullEscapedNpmName));
    const notNeeded = pkg.version;
    const latest = Semver.parse(findActualLatest(info.time));
    if (latest.equals(notNeeded) || latest.greaterThan(notNeeded) ||
        info.versions.has(notNeeded.versionString) && !assertDefined(info.versions.get(notNeeded.versionString)).deprecated) {
        const plusOne = new Semver(latest.major, latest.minor, latest.patch + 1);
        log(`Deprecation of ${notNeeded.versionString} failed, instead using ${plusOne.versionString}.`);
        return new NotNeededPackage({
            asOfVersion: plusOne.versionString,
            libraryName: pkg.libraryName,
            sourceRepoURL: pkg.sourceRepoURL,
            typingsPackageName: pkg.name,
        });
    }
    return pkg;
}

function findActualLatest(times: Map<string, string>) {
    const actual = best(
        times, ([k, v], [bestK, bestV]) =>
            (bestK === "modified" || bestK === "created") ? true :
            (k === "modified" || k === "created") ? false :
            new Date(v).getTime() > new Date(bestV).getTime());
    if (!actual) {
        throw new Error("failed to find actual latest");
    }
    return actual[0];
}

/** Version of a package published to NPM. */
export class Semver {
    static parse(semver: string, coerce?: boolean): Semver {
        const result = Semver.tryParse(semver, coerce);
        if (!result) {
            throw new Error(`Unexpected semver: ${semver}`);
        }
        return result;
    }

    static fromRaw({ major, minor, patch }: Semver): Semver {
        return new Semver(major, minor, patch);
    }

    /**
     * Per the semver spec <http://semver.org/#spec-item-2>:
     *
     *   A normal version number MUST take the form X.Y.Z where X, Y, and Z are non-negative integers, and MUST NOT contain leading zeroes.
     *
     * @note This must parse the output of `versionString`.
     *
     * @param semver The version string.
     * @param coerce Without this optional parameter the version MUST follow the above semver spec. However, when set to `true` components after the
     *               major version may be omitted. I.e. `1` equals `1.0` and `1.0.0`.
     */
    static tryParse(semver: string, coerce?: boolean): Semver | undefined {
        const rgx = /^(\d+)(\.(\d+))?(\.(\d+))?$/;
        const match = rgx.exec(semver);
        if (match) {
            const { 1: major, 3: minor, 5: patch } = match;
            if ((minor !== undefined && patch !== undefined) || coerce) { // tslint:disable-line:strict-type-predicates
                return new Semver(intOfString(major), intOfString(minor || "0"), intOfString(patch || "0"));
            }
        }
        return undefined;
    }

    constructor(readonly major: number, readonly minor: number, readonly patch: number) {}

    get versionString(): string {
        const { major, minor, patch } = this;
        return `${major}.${minor}.${patch}`;
    }

    equals(other: Semver): boolean {
        return compare(this, other) === 0;
    }

    greaterThan(other: Semver): boolean {
        return compare(this, other) === 1;
    }
}

/**
 * Returns 0 if equal, 1 if x > y, -1 if x < y
 */
export function compare(x: Semver, y: Semver) {
    const versions: Array<[number, number]> = [[x.major, y.major], [x.minor, y.minor], [x.patch, y.patch]];
    for (const [componentX, componentY] of versions) {
        if (componentX > componentY) {
            return 1;
        }
        if (componentX < componentY) {
            return -1;
        }
    }
    return 0;
}
