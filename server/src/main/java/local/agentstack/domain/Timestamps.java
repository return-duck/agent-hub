package local.agentstack.domain;

import java.time.Instant;
import java.time.temporal.ChronoUnit;

/**
 * 时间戳工具。
 *
 * schema 里所有时间列都是 DATETIME(3)（毫秒精度），而 Instant.now() 带纳秒。
 * 不截断的话，"写进去再读回来"会不相等，集成测试会以极其费解的方式失败。
 * 所以时间戳统一从这里取。
 */
public final class Timestamps {

    private Timestamps() {
    }

    public static Instant now() {
        return Instant.now().truncatedTo(ChronoUnit.MILLIS);
    }
}
